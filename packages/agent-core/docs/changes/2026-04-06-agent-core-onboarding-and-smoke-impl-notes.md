# Agent Core 文档与烟测补强说明

## 本次实现目标

补齐当前 `agent-core` 的近端工程缺口：

- 让 HTTP 层对坏请求返回明确的 `400` / `413`
- 增加覆盖真实 runtime 装配链路的烟测
- 增加一个新成员可直接上手的 `README.md`

## 代码改动

- `src/http.ts`
  - 为 malformed JSON 和 oversized body 引入明确的 HTTP 错误状态
  - 将 transport 级错误和内部异常区分开
- `tests/http.test.ts`
  - 新增 `POST /threads` 覆盖
  - 新增 malformed JSON 返回 `400`
  - 新增 oversized JSON body 返回 `413`
- `tests/runtime-smoke.test.ts`
  - 使用真实 `createAgentRuntime()`
  - 使用真实 `LocalShellBackend` 和 SQLite checkpointer
  - 通过替换 `runtime.agent.invoke` 的方式避免依赖外部模型服务
- `README.md`
  - 补充环境变量、CLI、HTTP 路由、`curl` 示例和验证命令

## 设计取舍

- 真实 runtime 烟测的目标是验证装配链路，而不是验证外部模型可用性
- 因此测试保留真实 backend 和 checkpointer，但把 `invoke` 响应固定成可预测值
- HTTP 层继续保持最小 adapter 定位，只补 transport 级错误语义，不向内扩散业务逻辑

## 验证结果

已执行：

- `npm run typecheck`
- `npm test`
- `npm run build`

结果：

- 类型检查通过
- 测试通过
- 构建通过
