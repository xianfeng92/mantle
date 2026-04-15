# Agent Core Context Compaction 实现说明

## 本次实现目标

把 `deepagents` 已经内建的 summarization / context compaction 能力显式接到 `agent-core` 上：

- 在 run / resume 结果里暴露当前 compaction 状态
- 在 SSE 中暴露本轮 `context_compacted` 事件
- 在 trace 中记录 `context_compacted`
- 补一个可调试的上下文窗口 hint 配置

## 本次改动

- `src/compaction.ts`
  - 新增 compaction state 提取与比较逻辑
- `src/agent.ts`
  - `AgentInvoker` 暴露 `getState()`
  - 增加 `AGENT_CORE_CONTEXT_WINDOW_TOKENS_HINT` 支持
- `src/service.ts`
  - 每轮执行前后读取 thread state
  - 检测 `_summarizationEvent` 变化
  - `ServiceRunResult` 增加 `contextCompaction`
  - streaming 增加 `context_compacted`
  - trace 增加 `context_compacted`
- `src/http.ts`
  - JSON 响应带 `contextCompaction`
  - SSE 支持 `context_compacted`
- `src/cli.ts`
  - verbose 模式下打印本轮 compaction 文件路径 / cutoff
- `tests/service.test.ts`
  - 覆盖 compaction 状态探测
- `tests/http.test.ts`
  - 覆盖 JSON 和 SSE 的 compaction 暴露

## 设计取舍

- 没有重写一套自定义 compaction middleware
  - 直接复用 `deepagents` 默认 summarization middleware
  - 这样和当前 `deepagentsjs` 基座保持一致，风险最低
- 当前主要补的是“可观测性”和“结果可见性”
  - 让 compaction 从隐含行为变成明确协议
- `AGENT_CORE_CONTEXT_WINDOW_TOKENS_HINT`
  - 不是一个全新的 compaction 算法配置
  - 它只是给 `deepagents` 默认阈值一个更稳定的窗口 hint，便于本地调试和小模型适配

## 验证结果

已执行：

- `npm run typecheck`
- `npm test`
- `npm run build`

结果：

- 类型检查通过
- 33 个 TypeScript 测试全部通过
- 构建通过
