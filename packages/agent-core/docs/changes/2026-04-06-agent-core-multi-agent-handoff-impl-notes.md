# Agent Core Multi-agent / Handoff 实现说明

## 本次实现目标

把 `deepagents` 已内建的 subagent / handoff 能力在 `agent-core` 里显式化，让它从“底层默认存在”变成“项目可配置、可观测、可调试”的能力：

- 明确暴露 general-purpose subagent
- 支持从工作区加载自定义 subagent
- 在 CLI 和 HTTP 层展示当前有效的 subagent 配置
- 为 subagent discovery / 解析 / runtime 暴露补测试

## 本次改动

- `src/subagents.ts`
  - 新增 `resolveSubagentSources()`
  - 新增 `loadSubagentsFromSources()`
  - 支持解析 `.deepagents/subagents/*.md`
  - frontmatter 支持 `name` / `description` / `model` / `skills`
- `src/settings.ts`
  - 新增 `AGENT_CORE_SUBAGENT_SOURCE_PATHS`
- `src/agent.ts`
  - runtime 创建时解析自定义 subagents
  - 透传给 `deepagents` 的 `subagents` 参数
  - 暴露 `generalPurposeSubagent`、`subagentSources` 和 `listSubagents()`
- `src/cli.ts`
  - 新增 `/subagents`
- `src/http.ts`
  - 新增 `GET /subagents`
  - 返回 `{ generalPurposeAgent, sources, subagents }`
- `src/serve.ts`
  - 启动 banner 补 `GET /subagents`
- `tests/subagents.test.ts`
  - 覆盖默认 source 发现与 frontmatter 解析
- `tests/http.test.ts`
  - 覆盖 `GET /subagents`
- `tests/runtime-smoke.test.ts`
  - 在临时工作区中创建真实 subagent fixture
  - 验证 runtime 和 HTTP service 能正确暴露 subagent 信息

## 设计取舍

- 不重写 handoff 协议
  - 直接复用 `deepagents` 现有 `task` tool / subagent middleware
  - `agent-core` 只补 discovery、配置和 observability
- general-purpose subagent 保持默认启用
  - 这是 `deepagents` 默认能力
  - 也让项目在没有自定义 subagent 时仍然具备最小 handoff 能力
- 自定义 subagent 先用 Markdown + frontmatter
  - 比纯 JSON 更适合写较长的 system prompt
  - 同时比引入完整 YAML 解析器更轻量
- 自定义 subagent 的 `skills` 路径必须位于工作区内
  - 与 skill system 和 workspace 边界保持一致

## 验证结果

已执行：

- `npm run typecheck`
- `npm test`
- `npm run build`

结果：

- 类型检查通过
- 39 个 TypeScript 测试全部通过
- 构建通过
