# Agent Core Parallel Tool Calls 实现说明

## 本次实现目标

把底层 agent graph 的并行 tool call 语义变成 `agent-core` 自己的显式配置契约，而不是继续依赖底层默认值：

- 为运行时增加 graph version 配置
- 让 run / resume / streaming 统一透传该配置
- 为配置解析和执行透传补测试

## 本次改动

- `src/settings.ts`
  - 新增 `AGENT_CORE_AGENT_GRAPH_VERSION`
  - 当前支持 `v1` / `v2`
  - 默认值为 `v2`
- `src/agent.ts`
  - 扩展 `AgentInvokeConfig`
- `src/service.ts`
  - run / resume 的 `invoke()` 透传 `version`
  - streaming 的 `streamEvents()` 透传同一 `version`
  - `run_started` trace payload 记录当前 `agentGraphVersion`
- `tests/settings.test.ts`
  - 覆盖 graph version 配置解析
- `tests/service.test.ts`
  - 覆盖默认 `v2` 配置透传
- `tests/http.test.ts`
  - 覆盖 HTTP JSON / SSE 路径的 graph version 透传
- `tests/runtime-smoke.test.ts`
  - 覆盖真实 runtime + HTTP service 的 graph version 透传

## 设计取舍

- 不在 `agent-core` 自己重写并行执行器
  - 当前并行 tool call 语义交给 LangChain / LangGraph
  - `agent-core` 只负责把它做成稳定的配置与协议
- 默认使用 `v2`
  - 避免继续依赖底层默认值是否变化
  - 也更贴近当前 LangChain agent graph 的主路径
- 保留 `v1`
  - 给兼容性、回归排查和后续实验留出明确切换点

## 验证结果

已执行：

- `npm run typecheck`
- `npm test`

结果：

- 类型检查通过
- 39 个 TypeScript 测试全部通过
