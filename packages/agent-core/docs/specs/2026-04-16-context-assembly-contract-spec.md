---
title: Context Assembly Contract
status: implemented
owner: claude
created: 2026-04-16
updated: 2026-04-16
implements:
  - docs/changes/2026-04-16-returns-plane-and-context-contract-impl-notes.md
reviews: []
---

# Context Assembly Contract

## 背景

ZeroClaw v0.3 架构文档（`~/Downloads/zeroclaw-architecture-v0_3.md`）记录了一条代价高昂的教训：同一个 agent 基座下，不同入口（IM channels、长会话 WS/ACP、Heartbeat headless）**独立演化出了结构性不同的上下文装配方式**——memory 注入位置、history 所有权、prompt 组装顺序各不相同。结果：

- 同一用户从 Telegram 和 WebSocket 进来，模型看到的上下文结构不同 → **行为漂移**
- Prompt cache 命中规则按路径各自一套 → **成本 + 延迟**
- 同一 bug 在 A 路径复现、B 路径不复现 → **调试困难**

ZeroClaw 把这列为"当前最值得讨论的 tradeoff / 未来收敛重构的第一优先级"。Mantle 目前只有一条活跃入口路径（HTTP `/runs` + `/runs/stream`），**立契约的成本几乎为零**；增加第二个入口之前把规则定下来，避免重演同样的演化包袱。

## 目标

**每个新增入口在合入 main 前必须在本文件里登记一条 Path Row**，声明它的上下文装配方式。不登记不合入。

本契约不约束行为单位（tools / skills），只约束**上下文如何进入模型**——即 system prompt 怎么拼、history 由谁拥有、memory 注入到哪一层、是否允许抢占。

## 术语

| 术语 | 含义 |
|---|---|
| **Path** | 一条从外部事件到 agent 执行的完整链路（如"HTTP POST /runs"、"Telegram channel"、"Heartbeat tick"） |
| **Surface** | Path 的用户侧呈现（CLI REPL / macOS 菜单栏 / 全局热键 / SSE 客户端）；一个 Surface 可能对应多个 Path |
| **Prompt Profile** | `src/system-prompt.ts` 中的一条 system prompt 预设（当前 `default` / `compact`） |
| **History Owner** | 谁持有多轮消息。**checkpointer** = 由 langgraph SqliteSaver 持久化到 `checkpoints.sqlite`（当前唯一模式）；**session-embedded** = 常驻对象自持（未采用）；**none** = single-turn |
| **Memory Injection Point** | `<memory>` 块拼到哪条消息上。**user-message** = 拼到用户消息前缀（当前唯一模式）；**system-prompt** = 拼到 system prompt；**none** = 不注入 |
| **Scope Key** | 用于打断 / 并发隔离的唯一键；相同 Scope Key 的后续请求会抢占前一个 |

## 不可违反的硬规则

1. **只有一个 memory 注入点**。要么全系统走 user-message，要么全系统走 system-prompt。**不允许**新增 path 时换位置，除非同时迁移所有现有 path 并更新本文件。
2. **Prompt Profile 切换必须基于模型能力，不基于入口类型**。当前规则：`gemma*` → `compact`，其他 → `default`（见 `settings.ts::resolvePromptProfile`）。新增入口继承这个规则，不自己再加维度。
3. **single-turn 路径必须显式声明 `history-owner: none`**。不允许"这个入口反正不需要历史"而静默跳过 checkpointer——要么走 checkpointer 拿到 threadId，要么明确单次。
4. **后台/主动任务的输出不走 response**。心跳 / ambient / 定时任务的结果必须进 Returns Plane（见 `2026-04-16-returns-plane-spec.md`），不能从入口连接回传——因为入口那时可能已经断了。

## 当前登记（baseline）

表格按"入口触发者 → Prompt 装配 → History → Memory → Scope"顺序读。

| Path | 触发者 | 入口实现 | Prompt Profile | History Owner | Memory Injection Point | Scope Key | Streaming |
|---|---|---|---|---|---|---|---|
| **http-run** | HTTP `POST /runs` | `http.ts::/runs` → `service.ts::AgentCoreServiceHarness.run` | 按 model 规则 | checkpointer (`threadId`) | user-message | `threadId` | no (single response) |
| **http-run-stream** | HTTP `POST /runs/stream` | `http.ts::/runs/stream` → `service.ts::streamRun` | 按 model 规则 | checkpointer (`threadId`) | user-message | `threadId` | SSE |
| **http-resume** | HTTP `POST /resume` + `/resume/stream` | `http.ts::/resume*` → `service.ts::resume` | 同原 run | checkpointer (`threadId`) | **none**（恢复 interrupt，不重注入） | `threadId` | optional SSE |
| **cli-repl** | `npm run dev` (`cli.ts`) | `cli.ts::AgentCoreCli.start` | 按 model 规则 | checkpointer (`threadId` via `resolveInitialThreadId`) | user-message | `threadId` | inline print |
| **twitter-digest** | HTTP `POST /twitter/digest` | `twitter-digest.ts::generateDigest` (bypass agent loop) | **独立 system prompt**（`BASE_SYSTEM` + mode） | none (single-turn) | **none** | request-scoped (no reuse) | no；`daily`/`weekly` 默认 dispatch 到 Returns Plane |

### 说明

- 前 4 条（http-run / http-run-stream / http-resume / cli-repl）**共享一套装配**——这是当前合流基线，不要分叉。
- `twitter-digest` 是**有意 bypass** agent loop 的 Direct caller，对应 ZeroClaw 的"Path Direct"概念。它不继承本契约的 Prompt Profile / Memory 装配，因为它是一次性结构化 JSON 调用，不属于对话路径。新增类似 Direct caller 时同样登记，但可以标注 `bypass: true`。

## 新增入口时的 Checklist

在 PR 里完成以下每一项，缺任一项视为违反契约：

- [ ] 在本文件表格新增一行 Path Row，字段齐全
- [ ] 明确写清触发者、入口文件、system prompt 来源
- [ ] 明确 History Owner：是沿用 `threadId` + checkpointer，还是 single-turn，还是新引入 session-embedded（后者需要 review）
- [ ] 明确 Memory Injection Point：**必须**与当前基线一致（user-message）。要换位置就开专门 RFC
- [ ] 明确 Scope Key：如果入口允许并发/抢占，说清 scope key 的三元组构成
- [ ] 如果是后台/主动任务：确认结果通过 Returns Plane 持久化，而不是从入口回传
- [ ] 如果引入新 Prompt Profile：在 `system-prompt.ts` 注册，且在 `resolvePromptProfile` 加入显式规则（不要 hardcode 到入口逻辑）

## Review 触发条件

下列任一变更需要单独开 review 文档（`docs/reviews/`）：

- **改动 Memory Injection Point**（从 user-message 改到 system-prompt 或反向）
- **新增 History Owner 类型**（如引入 session-embedded 对象）
- **新增一条不走 `service.ts::AgentCoreServiceHarness` 的 path**（意味着又长出一套装配）
- **Prompt Profile 选择逻辑依赖入口类型而非 model**

## 非目标（明确不管）

- Tools / Skills / Subagents 的注册和分发 —— 这些由 deepagents 的 middleware 机制负责，不在本契约范围
- Computer-use 的 GUI 动作编排 —— 属于 tool 层
- Prompt 内容本身的措辞 —— 本契约只管"由谁拼、拼到哪"，不管"拼什么"

## 参考

- ZeroClaw v0.3 架构文档 §3.2「上下文装配的分叉」
- `src/system-prompt.ts` —— 当前 prompt profile 定义
- `src/service.ts::AgentCoreServiceHarness` —— 当前唯一装配入口
- `2026-04-16-returns-plane-spec.md` —— 后台任务出口契约（配套）
