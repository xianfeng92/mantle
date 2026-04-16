---
title: Heartbeat Worker & HEARTBEAT.md
status: implemented
owner: claude
created: 2026-04-16
updated: 2026-04-16
implements:
  - docs/changes/2026-04-16-heartbeat-engine-impl-notes.md
reviews: []
---

# Heartbeat Worker & HEARTBEAT.md

## 背景

Mantle 的 proactive 能力到目前为止是硬编码的：`TwitterBookmarkDaemon` 在 Swift 侧定时触发，`/twitter/digest` 是特化路径。想加"每早 8 点跑通勤查询"需要改 Swift + TS 两处。

ZeroClaw v0.3 把这一层抽象成：`HEARTBEAT.md`（markdown 任务清单）+ tick-based engine → headless agent run → Returns Plane。本 spec 把这套抽象落到 Mantle。

## 目标

1. 用户在 `HEARTBEAT.md` 添加一条 YAML 条目就能新增一个定时任务，不改代码
2. 任务产出直接进 Returns Plane，`announce` 字段控制是否打扰用户
3. 和 `/twitter/digest` 正交——不强制把现有 ambient 任务立刻迁移
4. 自测友好：manual trigger 一个任务可以立刻看到结果

## 非目标（明确不做）

- **Two-phase LLM decision**（ZeroClaw 里先问 LLM "该跑哪几个"）—— 等 MVP 跑起来再看需不需要
- **Cron 表达式**—— 简单 schedule 格式够用；需要 cron 时再扩
- **任务间依赖 / DAG**—— tick 触发彼此独立
- **动态 reload**—— 启动时读一次；HEARTBEAT.md 变了要重启 agent-core（或手动 `POST /heartbeat/reload`）
- **覆盖现有 `/twitter/digest`**—— 那条路径继续存在，客户端 daemon 继续推送；HEARTBEAT 是新的并行面

## 文件格式

文件路径：`<workspaceDir>/HEARTBEAT.md`（默认；可通过 `AGENT_CORE_HEARTBEAT_FILE_PATH` 覆盖）。

```markdown
---
tasks:
  - id: morning-brief
    schedule: "daily 07:00"
    handler: agent-run
    prompt: |
      今天是周几？帮我列 3 件今天最该关注的事，基于我在 workspace 里的项目文件。
    announce:
      channels: ["macos-notification"]
      urgency: normal

  - id: weekly-repo-review
    schedule: "weekly fri 17:00"
    handler: agent-run
    prompt: |
      扫一下本周 git log，挑 3 条最值得周五回顾的改动。
---

# Heartbeat Tasks

自由的 markdown 说明区——给自己或下一任看的注释。
```

### 字段

| Field | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 唯一，kebab-case；用于持久化 state 和 manual trigger |
| `schedule` | ✅ | 见下「Schedule 格式」 |
| `handler` | ✅ | 内置 `agent-run`（MVP 唯一）；未来扩展点 |
| `prompt` | handler=agent-run 时必填 | 传给 headless agent 的用户消息 |
| `announce.channels` | 否 | 传给 Returns Plane，留给下游（macOS 客户端）决定怎么用 |
| `announce.urgency` | 否 | `low` / `normal` / `high` |
| `tags` | 否 | 写入 return entry 的 tags |
| `enabled` | 否 | 默认 true；false 保留条目但不调度 |

### Schedule 格式

- `daily HH:MM` —— 每天本地时间 HH:MM 触发一次
- `weekly DAY HH:MM` —— `DAY ∈ mon|tue|wed|thu|fri|sat|sun`
- `every N minutes` / `every N hours` —— 固定间隔，N 为整数

所有时间按 agent-core 运行时所在机器的**本地时区**解释（和车机 / 桌面场景一致）。

## 运行时

### Engine 职责

1. 启动时读 HEARTBEAT.md，解析 tasks 列表
2. 加载 `<dataDir>/heartbeat-state.json`，恢复每个 task 的 `lastFiredAt`
3. 每 `tickIntervalSec` 秒（默认 30s）检查：对每个 enabled task，按 schedule 计算 `nextFireAt`；如果 `now >= nextFireAt`，触发 handler
4. Handler 执行完毕，写 state，dispatch ReturnDraft 到 Returns Plane

### Handler

**MVP 唯一内置：`agent-run`**

执行步骤：
1. 取 task.prompt
2. 调 `AgentCoreServiceHarness.runOnce({ threadId: "heartbeat:<taskId>:<timestamp>", input: prompt, maxInterrupts: 0 })`
3. 从返回消息中提取最后一条 assistant text
4. 构造 `ReturnDraft`:
   - `kind: "heartbeat.agent-run"`
   - `title: task.id`
   - `summary: <assistant text 前 300 字>`
   - `payload: { taskId, prompt, messages, traceId }`
   - `tags: ["heartbeat", task.id, ...(task.tags ?? [])]`
   - `source: { taskId: "heartbeat:<id>", traceId }`
   - `announce: task.announce`
5. `returnDispatcher.dispatch(draft)` → 进 Returns Plane → macOS Inbox 可见

HITL 在 headless 上下文没有意义（没有人坐在前面响应），所以 `maxInterrupts: 0`——如果任务 prompt 触发了需要审批的工具，整个任务就 fail，错误进 ReturnEntry 的 summary 里让用户看到。

### 持久化

`<dataDir>/heartbeat-state.json`:

```json
{
  "tasks": {
    "morning-brief": {
      "lastFiredAt": "2026-04-16T07:00:02.123Z",
      "lastStatus": "ok",
      "lastReturnId": "..."
    }
  }
}
```

每次 fire 后更新；损坏时重建（空对象）。

## HTTP API

| Method | Path | 行为 |
|---|---|---|
| `GET` | `/heartbeat/tasks` | 列出所有任务 + 当前 state + 下次触发时间 |
| `POST` | `/heartbeat/tasks/:id/run-now` | 立即触发一次（测试 / debug 用）；写 state + dispatch |
| `POST` | `/heartbeat/reload` | 重读 HEARTBEAT.md（修改后免重启） |

无订阅端点——新产出通过 Returns Plane 的 `/returns/stream` 广播，客户端已经订阅，不重复造。

## 启用 / 停用

默认**启用**。关掉：环境变量 `AGENT_CORE_HEARTBEAT_ENABLED=false`。理由：Mantle 启动即期望 ambient 能力；生产里的 kill switch 交给 env。

## 测试

1. **Parser**：YAML frontmatter 提取；schedule 枚举；必填字段校验
2. **Scheduler**：给定 `lastFiredAt` + `schedule` + `now`，计算正确的 `nextFireAt`；边界（跨日 / 跨周）
3. **Engine smoke**：用假的 harness + fake dispatcher 跑一个完整 tick，验证 state 被写 + draft 被 dispatch

## Follow-up（不在本 PR）

- `twitter-digest.daily` 迁移成一条 HEARTBEAT 条目（需要额外 handler kind：`twitter-digest-daily`，负责从 SwiftData 拉 bookmarks——还是留在 Mantle 侧推送更合理）
- Two-phase decision：tick 先问 LLM "从候选里选 K 条该跑的"
- `HEARTBEAT.md` 热加载（inotify）
- 把 handler 做成可注册的：外部模块可 `engine.registerHandler("custom-kind", fn)`
