# Agent Core Tracing / Observability 实现说明

## 本次实现目标

为 `agent-core` 增加最小但可用的 tracing / observability 能力：

- 每次 run / resume 生成稳定的 `traceId`
- 将关键生命周期事件持久化到本地 JSONL
- 通过 HTTP 暴露 trace 查询入口

## 本次改动

- `src/tracing.ts`
  - 新增 `JsonlTraceRecorder`
  - 支持 `record()`、`listRecent()`、`getTrace()`
- `src/agent.ts`
  - runtime 创建时注入 `traceRecorder`
- `src/service.ts`
  - `ServiceRunResult` 新增 `traceId`
  - 为 run start / complete / interrupt / failure 记录 trace 事件
  - 为 streaming 路径补充 `text_delta` 和工具生命周期 trace
- `src/http.ts`
  - 普通 run / resume 响应带 `traceId`
  - HTTP 响应头增加 `X-Agent-Core-Trace-Id`
  - 新增 `GET /traces`
  - 新增 `GET /traces/:traceId`
- `src/cli.ts`
  - verbose 模式下打印当前 run 的 `traceId`
- `tests/tracing.test.ts`
  - 覆盖 JSONL trace recorder 的持久化和过滤能力

## 持久化格式

默认日志路径：

- `.agent-core/traces.jsonl`

每一行是一个 JSON object，核心字段包括：

- `timestamp`
- `traceId`
- `threadId`
- `kind`
- `mode`
- `durationMs`
- `payload`

## HTTP 可观测性

当前查询入口：

- `GET /traces?limit=100`
- `GET /traces/:traceId`

设计原则：

- 查询接口只暴露稳定的本地 trace 事件，不直接暴露底层 LangGraph 原始 event schema
- 普通 JSON 接口和 SSE 接口都共享同一个 `traceId` 概念
- SSE 仍然负责实时消费，`/traces` 负责事后排查

## 验证结果

已执行：

- `npm run typecheck`
- `npm test`
- `npm run build`
- `printf '/quit\n' | npm run dev`
- `npm run serve` + `curl http://127.0.0.1:8787/health`

结果：

- 类型检查通过
- 25 个 TypeScript 测试全部通过
- 构建通过
- CLI 可以正常启动并退出
- HTTP 服务健康检查通过
