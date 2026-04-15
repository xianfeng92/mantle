# Agent Core 最小 HTTP 服务实现说明

## 本次实现目标

在现有 `runOnce()` / `resumeOnce()` service harness 之上增加一个最小 HTTP adapter，让 CLI 之外的调用方也能通过稳定的本地接口驱动 agent。

## 新增文件

- `src/http.ts`
  - 提供 `AgentCoreHttpServer`
  - 负责 JSON body 解析、基础参数校验、消息序列化、线程清理和 CORS 头
- `src/serve.ts`
  - 提供 HTTP 服务入口
  - 负责加载 settings、创建 runtime、监听信号并优雅退出
- `tests/http.test.ts`
  - 覆盖 health、run、resume、delete thread 路由

## 路由设计

### `GET /health`

- 返回 `{ ok: true, service: "agent-core" }`
- 用于本地存活探测与启动验证

### `POST /threads`

- 可选传入 `threadId`
- 未传时由服务端生成 UUID
- 会同步重置 service harness 对该 thread 的本地 cursor 状态

### `POST /runs`

请求体：

```json
{
  "threadId": "optional-thread-id",
  "input": "帮我看看当前目录",
  "maxInterrupts": 1
}
```

行为：

- 若未提供 `threadId`，服务端生成新 UUID
- 调用 `AgentCoreServiceHarness.runOnce()`
- 返回序列化后的消息列表、增量消息列表和可选 interrupt payload

### `POST /resume`

请求体：

```json
{
  "threadId": "thread-id",
  "resume": {
    "decisions": [
      { "type": "approve" }
    ]
  }
}
```

行为：

- 调用 `AgentCoreServiceHarness.resumeOnce()`
- 继续执行被 HITL 中断的线程

### `DELETE /threads/:threadId`

- 清理 service harness 中该 thread 的内存态
- 如果底层 checkpointer 支持 `deleteThread()`，同时删除持久化 checkpoint

## 实现决策

- HTTP 层只做 transport adapter，不复制 CLI 中的审批逻辑
- 所有会话状态继续以 `thread_id` 为主键，由 SQLite checkpointer 管理
- HTTP 响应中的消息统一序列化为 `role`、`text`、`content` 等稳定字段，降低调用方耦合
- 默认监听 `127.0.0.1:8787`，并通过 settings 暴露 `AGENT_CORE_HTTP_HOST` / `AGENT_CORE_HTTP_PORT`
- `serve` 脚本使用 `tsx src/serve.ts`，构建后对应 `node dist/src/serve.js`

## 验证结果

已执行：

- `npm run typecheck`
- `npm test`
- `npm run build`

结果：

- 类型检查通过
- 17 个 TypeScript 测试全部通过
- 构建通过
