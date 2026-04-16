# Heartbeat Engine —— 实施笔记

**Date**: 2026-04-16
**Implements**: `docs/specs/2026-04-16-heartbeat-spec.md`

## 背景

Returns Plane 的第一条真实订阅端（Mantle 菜单栏 Inbox）已经跑通，但目前唯一的发布方还是 Mantle 客户端推的 `twitter-digest`——proactive 发起方还不在 agent-core 侧。ZeroClaw 架构里让 agent 真正"自己动起来"的部件是 Heartbeat Worker。本 PR 把它落下来。

## 改动

**新增**：

- [src/heartbeat/types.ts](../../src/heartbeat/types.ts) —— `HeartbeatTaskDef` / `HeartbeatState` / `HeartbeatTaskStatus`
- [src/heartbeat/parser.ts](../../src/heartbeat/parser.ts) —— 读 HEARTBEAT.md 的 YAML frontmatter；逐条校验 id / schedule / handler / prompt；不吞错，返回 `errors[]` 给 HTTP 端点
- [src/heartbeat/scheduler.ts](../../src/heartbeat/scheduler.ts) —— 纯时间数学，支持 `daily HH:MM` / `weekly DAY HH:MM` / `every N (minutes|hours)`；本地时区
- [src/heartbeat/engine.ts](../../src/heartbeat/engine.ts) —— 引擎本体：启动时读文件 + 加载 state；定时 tick 检查 due 任务；`runNow(taskId)` 供 HTTP 手动触发；`agent-run` handler 调 `AgentCoreServiceHarness.runOnce` + 把 assistant text 作为 summary dispatch 到 Returns Plane
- [HEARTBEAT.md](../../HEARTBEAT.md) —— 空 tasks + 文档注释示例
- [tests/heartbeat.test.ts](../../tests/heartbeat.test.ts) —— parser / scheduler / engine smoke 共 17 个 case

**改动**：

- [src/settings.ts](../../src/settings.ts) —— 4 个新字段：`heartbeatFilePath` / `heartbeatStatePath` / `heartbeatEnabled`（env `AGENT_CORE_HEARTBEAT_ENABLED`，默认 true） / `heartbeatTickIntervalSec`（默认 30）
- [src/agent.ts](../../src/agent.ts) —— `AgentRuntime` 加可选 `heartbeat` 字段；`createAgentRuntime` 在 `heartbeatEnabled` 时构造 `HeartbeatEngine` 并 `start()`；`close()` 调 `engine.stop()`
- [src/http.ts](../../src/http.ts) —— 3 个新端点：`GET /heartbeat/tasks` / `POST /heartbeat/reload` / `POST /heartbeat/tasks/:id/run-now`
- `package.json` —— 新依赖 `yaml ^2.8.3`

## 关键设计取舍

### 1. Handler 目前只有一个

MVP 只有 `agent-run`（prompt → headless agent → assistant text）。没有做可注册的 handler 插件机制——等真实需要第二种 handler 时再抽象。扩展点在 `engine.ts::runHandler`。

### 2. HITL 在 heartbeat 里是硬失败

`runOnce({ maxInterrupts: 0 })`。因为没人坐在电脑前回答"是否允许这个工具"。如果 prompt 里触发审批，整个任务进 ReturnEntry 的 error 状态，用户在 Inbox 里能看到 `[error] taskId`。

### 3. "错过的 slot 只补最近一次"

如果引擎凌晨 3 点崩了，早上 7 点重启，`daily 07:00` 的任务会**立刻**执行一次今天 07:00 的 slot——不会补昨天、前天。见 `scheduler.ts::isDue` 注释。这个规则简单直接，也是 ZeroClaw 的隐含假设。

### 4. 热加载通过 HTTP reload，不做 inotify

省掉了 watch 文件 + 防抖的复杂性。用户修改 HEARTBEAT.md 后 `curl -X POST /heartbeat/reload` 即可。未来有需要再加 inotify。

### 5. 默认启用

`heartbeatEnabled` 默认 `true`——Mantle 的定位就是 proactive agent 基座，默认就应该开着。Kill switch：`AGENT_CORE_HEARTBEAT_ENABLED=false`。

## 端到端链路

现在是这样的：

```
HEARTBEAT.md: "morning-brief daily 07:00 → prompt 'xxx'"
    ↓ 启动时解析
HeartbeatEngine.start()
    ↓ 每 30s tick
isDue? → yes
    ↓
AgentCoreServiceHarness.runOnce({ threadId: "heartbeat:morning-brief:...",
                                   input: prompt, maxInterrupts: 0 })
    ↓
assistantText = extractLastAssistantText(messages)
    ↓
ReturnDispatcher.dispatch({ kind: "heartbeat.agent-run", summary: assistantText[:300], ... })
    ↓
ReturnStore (JSONL) + SSE broadcast
    ↓
Mantle ReturnsService 订阅收到 → Inbox 角标 +1
```

所有环节都已在各自的 PR 落地 + 测试覆盖。

## 验证

- `npm run typecheck` ✅
- `npx tsx --test tests/heartbeat.test.ts` → 17/17 ✅
- 核心测试池（heartbeat + returns + twitter-digest + http + service + settings + memory + guardrails + hitl + audit-log）→ 85/85 ✅

## Follow-up

- **twitter-digest 迁移为 HEARTBEAT 条目**：要新建 `twitter-digest.daily` handler，能从 Mantle 侧拉 bookmarks——其实更合理的做法是 Mantle 继续推（它手上有 SwiftData），heartbeat 只负责触发一个 HTTP 请求给 Mantle。暂时不做
- **Two-phase LLM decision**：tick 先问 LLM "从候选里选 K 条该跑的"，再执行选中的。等看到 N 个任务堆积、单次 tick 里过饱和时再做
- **UI**：Mantle 菜单栏 Settings 加一个 "Heartbeat" 面板，可以看 `GET /heartbeat/tasks` 的 status
- **Daily cap**：防止 `every 10 minutes` 一天打出 144 个 entry——在 Returns Plane / engine 里加个每日 FIFO 限制
