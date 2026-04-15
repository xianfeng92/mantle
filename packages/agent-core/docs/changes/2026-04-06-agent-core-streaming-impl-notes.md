# Agent Core SSE Streaming 实现说明

## 本次实现目标

在现有最小 HTTP 服务之上增加 SSE streaming，让调用方可以实时消费模型文本增量、工具生命周期事件以及最终完成/中断结果。

## 本次改动

- `src/service.ts`
  - 新增 `streamRun()` / `streamResume()`
  - 基于 LangGraph `streamEvents()` 抽象出稳定的 service 级事件
- `src/http.ts`
  - 新增 `POST /runs/stream`
  - 新增 `POST /resume/stream`
  - 增加 SSE 响应头和事件序列化
- `src/serve.ts`
  - 启动 banner 中补充 streaming 路由
- `tests/http.test.ts`
  - 覆盖流式 run 和流式 resume
- `tests/runtime-smoke.test.ts`
  - 用真实 runtime + 临时工作区补一条 streaming 烟测

## SSE 协议

当前对外事件名：

- `run_started`
- `text_delta`
- `tool_started`
- `tool_finished`
- `tool_failed`
- `run_interrupted`
- `run_completed`
- `error`

设计原则：

- HTTP 层对外暴露稳定事件名，不直接透传 LangGraph 内部事件格式
- 最终 `run_completed` / `run_interrupted` 事件中仍返回标准化后的 `ServiceRunResult`
- 中断后由客户端调用 `/resume` 或 `/resume/stream` 继续执行，而不是在单个 SSE 连接里自动审批

## 设计取舍

- 当前只实现 HTTP SSE streaming，CLI 仍保持非流式渲染
- 文本增量来自底层 `on_chat_model_stream` / `on_llm_stream`
- 工具事件来自 `on_tool_start` / `on_tool_end` / `on_tool_error`
- service 层统一把底层事件映射成少量高信号事件，减少前端耦合

## 验证结果

已执行：

- `npm run typecheck`
- `npm test`

结果：

- 类型检查通过
- 23 个 TypeScript 测试全部通过
