# Agent Core Skill System 实现说明

## 本次实现目标

把 `deepagents` 已有的 skill loader 正式接到 `agent-core` 当前运行时里，并补齐调试和运维可见性：

- 自动发现工作区内的 skill source
- 把 skill source 映射成 `deepagents` 可识别的 backend path
- 在 CLI 和 HTTP 层暴露已加载的 skills
- 为 skill discovery / metadata 加载补测试

## 本次改动

- `src/skills.ts`
  - 新增 `resolveSkillSources()`
  - 新增 `listSkillsFromSources()`
  - 定义统一的 `SkillSource` / `SkillMetadata`
- `src/settings.ts`
  - 新增 `AGENT_CORE_SKILL_SOURCE_PATHS`
- `src/agent.ts`
  - runtime 创建时解析 skill source
  - 透传给 `deepagents` 的 `skills` 参数
  - 暴露 `runtime.skillSources` 与 `runtime.listSkills()`
- `src/cli.ts`
  - 新增 `/skills` 命令
  - 支持在终端中查看当前 source 和 skill metadata
- `src/http.ts`
  - 新增 `GET /skills`
  - 返回 `{ sources, skills }`
- `src/serve.ts`
  - 启动 banner 补 `GET /skills`
- `tests/skills.test.ts`
  - 覆盖默认 source 发现和 metadata 解析
- `tests/http.test.ts`
  - 覆盖 `GET /skills`
- `tests/runtime-smoke.test.ts`
  - 在临时工作区中创建真实 skill fixture
  - 验证运行时和 HTTP service 可以正确暴露 skill 信息

## 设计取舍

- 默认只自动发现 `.deepagents/skills`
  - 这是对 `deepagents` 习惯用法最小且明确的对齐
  - 如果项目需要更多目录，再通过 `AGENT_CORE_SKILL_SOURCE_PATHS` 显式追加
- skill source 必须限制在工作区内
  - 避免从任意宿主目录静默加载外部 skills
  - 也让 HTTP `/skills` 输出与当前 workspace 安全边界保持一致
- HTTP 和 CLI 只暴露 metadata，不直接在这一层做 skill 编辑或安装
  - 先把 discovery 和 observability 做扎实
  - skill 生命周期管理后续再扩展

## 验证结果

已执行：

- `npm run typecheck`
- `npm test`

结果：

- 类型检查通过
- 36 个 TypeScript 测试全部通过
