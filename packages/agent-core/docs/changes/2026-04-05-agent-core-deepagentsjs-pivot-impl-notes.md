# Agent Core deepagentsjs 迁移说明

## 本次实现目标

将 `agent-core` 从自研 Python MVP 切换为基于 `deepagentsjs` 的 TypeScript 运行时，直接复用 LangChain / LangGraph 生态提供的 agent loop、checkpoint 和 human-in-the-loop 机制。

## 当前活跃实现

- `src/agent.ts`
  - 创建 `ChatOpenAI`
  - 创建 `LocalShellBackend`
  - 创建带 `interruptOn` 的 deep agent
- `src/cli.ts`
  - 提供交互式 REPL
  - 支持 thread id 续跑
  - 支持对中断工具调用做 approve / edit / reject
- `src/hitl.ts`
  - 定义写文件、编辑文件、执行命令三类敏感工具的审批规则
- `src/settings.ts`
  - 统一加载模型、工作区、命令超时、输出上限、持久化路径和 `virtualMode` 配置
- `src/http.ts`
  - 提供最小 HTTP adapter，复用 service harness 暴露 `health` / `runs` / `resume` 等路由
- `src/serve.ts`
  - 提供 HTTP 服务启动入口
- `src/persistence.ts`
  - 管理最近一次 thread id 的本地状态文件
- `src/service.ts`
  - 提供 UI 无关的 `runOnce()` / `resumeOnce()` harness 接口
- `tests/settings.test.ts`
  - 覆盖配置解析
- `tests/hitl.test.ts`
  - 覆盖 HITL 配置和中断提取
- `tests/persistence.test.ts`
  - 覆盖 session 元数据文件读写和 thread 恢复
- `tests/service.test.ts`
  - 覆盖通用 service harness 的执行与恢复流程
- `tests/http.test.ts`
  - 覆盖最小 HTTP 服务的健康检查、执行、恢复和 thread 清理

## 关键实现决策

- 不再实现自定义 `Runner` / `ToolRegistry` / `MessageStore`，改为让 `deepagentsjs` 承担 agent loop 和工具编排
- 文件系统与命令工具统一来自 `LocalShellBackend`
- 人工审批通过 `interruptOn` + LangGraph `Command({ resume })` 完成
- 对话 checkpoint 使用官方 `@langchain/langgraph-checkpoint-sqlite` 落到本地 SQLite
- 最近一次 thread id 通过 `session.json` 自动记住，重启 CLI 默认续跑
- CLI 的单轮执行协议已经下沉到通用 service harness，后续 Web/API/Android 可直接复用
- 最小 HTTP 服务直接复用 service harness，因此 CLI 与 HTTP 调用方共享同一执行协议
- 默认启用 `virtualMode`，将绝对路径限制到工作区根目录下，减少路径越界风险
- OpenAI 兼容模型通过 `@langchain/openai` 接入，因此可以直接对接 LM Studio、Ollama 或其他兼容网关

## 与旧 Python 原型的关系

- 旧 Python 代码已从仓库移除，不再作为可运行备选实现存在
- 当前默认运行入口已经切换为 `src/index.ts`
- 规格文档里的 Python 风格接口现在主要用于表达协议，不再代表实际文件布局

## 验证结果

已执行：

- `npm run typecheck`
- `npm test`
- `npm run build`
- `printf '/quit\n' | npm run dev`

结果：

- 类型检查通过
- 17 个 TypeScript 测试全部通过
- 构建通过
- CLI 可以正常启动并退出
