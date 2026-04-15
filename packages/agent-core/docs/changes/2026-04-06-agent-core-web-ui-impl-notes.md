# Agent Core Web UI 实现说明

## 本次实现目标

为本地 `agent-core` 运行时补一个可直接在 Mac 上使用的浏览器前端，优先复用现有 HTTP / SSE 协议，而不是再定义一套新的传输层。

## 技术选型

- UI 框架：`assistant-ui`
- 应用基座：React 19 + TypeScript + Vite
- 集成方式：`useExternalStoreRuntime()`

选型原因：

- 可以直接接自定义后端
- 适合当前已有的 `/runs/stream`、`/resume/stream` 和 HITL 中断协议
- 不需要先把 `agent-core` 改造成 OpenAI 或 AG-UI 兼容接口

## 本次改动

- `web/src/hooks/use-agent-core-app.ts`
  - 建立浏览器端线程状态
  - 对接后端 `/health`、`/skills`、`/subagents`
  - 对接 `/runs/stream` 和 `/resume/stream`
  - 处理审批中断的 approve / reject / edit
- `web/src/lib/agent-core.ts`
  - 封装 HTTP / SSE 请求
  - 用 `zod` 校验服务端响应
- `web/src/lib/thread-messages.ts`
  - 将 `agent-core` 返回的消息转换成 assistant-ui 的 `ThreadMessage`
- `web/src/App.tsx`
  - 实现三栏布局和审批面板
- `web/src/index.css`
  - 实现本地 cockpit 风格界面
- `web/.env.example`
  - 增加前端默认后端地址示例
- `web/README.md`
  - 增加前端单独启动说明
- `README.md`
  - 增加主项目层面的 Web UI 启动说明

## 设计取舍

- 前端目前直接调用 `agent-core` HTTP 服务，不额外加 BFF
- 会话线程先保存在浏览器状态里，不单独实现前端持久化
- 审批中断沿用当前后端 `resume` 协议，不引入新的 UI 专用命令格式
- 不依赖 assistant-ui 默认 transport，而是用 external store adapter 贴合现有后端

## 验证结果

已执行：

- `cd /Users/xforg/AI_SPACE/agent-core/web && npm run lint`
- `cd /Users/xforg/AI_SPACE/agent-core/web && npm run build`
- `cd /Users/xforg/AI_SPACE/agent-core/web && npm run dev -- --host 127.0.0.1 --port 4173`
- `curl -I http://127.0.0.1:4173`

结果：

- lint 通过
- TypeScript 构建通过
- Vite 本地开发服务可以正常启动
- 浏览器入口可以返回 `200 OK`

## 当前已知边界

- 这次还没有补自动化前端 UI 测试
- 线程列表当前只保存在浏览器内存里，刷新页面后不会恢复
- 页面是否能拿到真实 agent 数据，仍依赖本地 `agent-core` 后端已经配置并启动
