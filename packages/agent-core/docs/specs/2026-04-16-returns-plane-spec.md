---
title: Returns Plane
status: implemented
owner: claude
created: 2026-04-16
updated: 2026-04-16
implements:
  - docs/changes/2026-04-16-returns-plane-and-context-contract-impl-notes.md
  - docs/changes/2026-04-16-twitter-digest-returns-plane-impl-notes.md
reviews: []
---

# Returns Plane —— 后台/主动任务的统一出口

## 背景

Mantle 的 README 明确写了"ambient workflows such as bookmark digestion"，`src/twitter-digest.ts` 已是第一个实例。这类任务的共同特征：

- **触发者不是当前 HTTP 请求**（可能是定时 daemon / 以后的 Heartbeat / macOS 系统事件）
- **产出结果有价值但不一定要打扰用户**（bookmark 日报可以写档，电池告警才值得弹通知）
- **客户端可能此时不在线**（macOS app 没开、SSE 未连）

当前 `/twitter/digest` 只把结果写回 HTTP response。如果触发者是后台 daemon，用完即丢；macOS app 想"回来看看今天攒了什么" —— 没有地方可看。

ZeroClaw v0.3 的 Returns Plane 就是为这类场景设计的统一出口。本 spec 把这套抽象落到 Mantle 上。

## 目标

提供一个**可订阅、可持久化、可查询**的后台任务结果平面：

1. 任何后台或主动任务完成后，**调用一次** `dispatch` 就把结果放进 Returns Plane
2. 结果持久化到 `<dataDir>/returns.jsonl`，重启不丢
3. macOS 客户端通过 HTTP `GET /returns` 拉取最近 N 条、`GET /returns/stream` 订阅新增
4. 是否额外"打扰用户"（通知中心 / 菜单栏徽标）是**独立决策**，不在本 plane 里硬绑定

关键取舍（ZeroClaw 核心判断）：**Returns Plane 默认克制——只存档不打扰**。要打扰，发布方显式把 `announce: true` 或 `announce.channels` 写进 entry，下游（macOS app）自行决定怎么处理。

## 非目标

- 不做**跨设备同步**（Returns Plane 是本机 JSONL）
- 不做**全文搜索 / 向量召回**（那是 memory 的事）
- 不自动把 Returns Plane 内容注入 agent 上下文（如果某条 entry 重要，由 memory writer 挑出来显式存 memory）
- 不替换 trace log / audit log —— 它们记录 agent 内部事件，Returns Plane 记录"面向用户的可交付结果"

## 数据模型

```ts
interface ReturnEntry {
  id: string;                    // uuid
  kind: string;                  // "twitter-digest" | "heartbeat" | 未来新增
  title: string;                 // 列表里显示的一行
  summary?: string;              // 可选的一段摘要
  payload: unknown;              // 结构化结果（JSON，由 kind 决定 schema）
  tags: string[];
  createdAt: string;             // ISO
  source: {
    taskId?: string;             // 触发任务的 id（heartbeat 任务名 / digest request id）
    traceId?: string;            // 如果任务走了 agent loop，记录 traceId 便于 join
  };
  announce?: {
    channels: string[];          // e.g. ["macos-notification", "menubar-badge"]；空数组或缺省 = 只存档
    urgency?: "low" | "normal" | "high";
  };
  ackedAt?: string;              // 客户端 ack 后填充；用于列表"未读数"
}
```

**关于 payload**：每个 kind 自己约定 schema，Returns Plane 不校验。`twitter-digest` 的 payload 就是 `DailyResponseSchema` / `WeeklyResponseSchema` 的产出。新增 kind 时在 `docs/specs/` 下补一份 `<kind>-return-schema.md` 或在调用方代码里用 zod 明确。

## 存储

- 文件：`<dataDir>/returns.jsonl`（和 `memory.jsonl` / `audit.jsonl` 同目录，同 JSONL 约定）
- 路径由 `settings.returnsLogPath` 提供，env `AGENT_CORE_RETURNS_LOG_PATH` 可覆盖
- 容量上限：默认 500 条，超出 FIFO 裁剪（沿用 `MemoryStore` 的同款策略）
- 损坏行静默跳过（和 memory 一致）

## 运行时组件

`src/returns.ts` 导出：

- `ReturnStore` —— JSONL CRUD（`list / get / append / ack / delete / clear`）
- `ReturnDispatcher` —— `store + EventEmitter`；`dispatch(entry)` 写盘后向订阅者广播

`AgentRuntime` 增加 `returnStore` 和 `returnDispatcher` 字段，由 `createAgentRuntime` 装配。

## HTTP 接口

| Method | Path | 行为 |
|---|---|---|
| `GET` | `/returns` | 列出最近 N 条（query `limit`, default 50；`since` ISO 时间戳过滤；`unackedOnly=true` 仅未 ack） |
| `GET` | `/returns/:id` | 读单条 |
| `POST` | `/returns` | 创建一条（供后台任务 POST；body 是去掉 `id/createdAt` 的 `ReturnEntry`） |
| `POST` | `/returns/:id/ack` | 标记已读，写 `ackedAt` |
| `DELETE` | `/returns/:id` | 删单条 |
| `GET` | `/returns/stream` | SSE 订阅新增；event name `return.created`，data 是完整 entry |

**Direct caller bypass**：`/returns/*` 是 CRUD + 订阅端点，**不经过 agent loop**，同 `/memory` 一样走直调。不在 Context Assembly Contract 的 Path Row 中登记（那份契约只管进 agent 的入口）。

## 与 twitter-digest 的关系

**已接入**（见 `docs/changes/2026-04-16-twitter-digest-returns-plane-impl-notes.md`）：

- `POST /twitter/digest` 请求体增加 `persist?: boolean`，为 true 时 dispatch 到 Returns Plane
- `daily` / `weekly` 两个 mode 默认 `persist: true`（属于"日 / 周"级产出）
- `summarize` mode 默认 `persist: false`（是中间产物）
- 成功 dispatch 时 response body 额外带 `returnId` 字段，caller 可以用它去 `GET /returns/:id` 或订阅 `/returns/stream`

Draft 构造逻辑在 `twitter-digest.ts::buildDigestReturnDraft` 里（kind = `twitter-digest.daily` / `twitter-digest.weekly`）。

## 测试

最小必要测试：

1. `ReturnStore`：add / list / get / ack / delete / clear；JSONL 损坏行跳过；capacity FIFO
2. `ReturnDispatcher`：dispatch 后订阅者收到 event；多订阅者广播；取消订阅后不再收到

HTTP 集成测试可以放到 follow-up（migration PR 一起做）。

## 非决策（留到有实际需求再定）

- 跨设备/多客户端 fan-out 策略（目前单机）
- 过期归档（目前只 FIFO 裁）
- 按 kind 分库存储（目前一个 JSONL 解决）
- `announce.channels` 的枚举收敛 —— 先让发布方随便填，看实际用出来哪些再立枚举
