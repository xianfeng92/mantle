# Agent Core Web

`agent-core/web` 是基于 `assistant-ui`、React 19 和 Vite 的本地浏览器前端，用来连接 `agent-core` 现有的 HTTP / SSE 服务。

当前支持：

- 多线程本地会话切换
- `/runs/stream` 和 `/resume/stream` 的实时文本增量
- 审批中断的 approve / reject / edit
- skills / subagents / trace id / tool 事件侧边栏
- 可切换的后端 base URL

## 本地运行

先启动后端：

```bash
cd /Users/xforg/AI_SPACE/mantle-monorepo/packages/agent-core
npm run serve
```

再启动前端：

```bash
cd /Users/xforg/AI_SPACE/mantle-monorepo/packages/agent-core/web
cp .env.example .env.local
npm install
npm run dev -- --host 127.0.0.1 --port 5173
```

默认会连接：

```bash
VITE_AGENT_CORE_BASE_URL=http://127.0.0.1:8787
```

打开浏览器访问：

```text
http://127.0.0.1:5173
```

## 构建

```bash
npm run typecheck
npm run lint
npm run build
```

构建产物会输出到 `dist/`。

## UI 结构

- 左侧：后端 URL、健康状态、skills、subagents、线程列表
- 中间：聊天线程、审批面板、输入框
- 右侧：工具事件、已加载技能、subagent、最近错误

## 协议依赖

当前前端直接消费这些后端接口：

- `GET /health`
- `GET /skills`
- `GET /subagents`
- `POST /runs/stream`
- `POST /resume/stream`

`agent-core` HTTP 服务默认已经开启 CORS，所以本地 `5173 -> 8787` 的浏览器调用可以直接工作。
