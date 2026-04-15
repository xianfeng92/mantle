# agent-core

`agent-core` 是一套基于 `deepagentsjs` 的本地开发 agent 运行时，当前同时提供 CLI 和最小 HTTP 服务。

默认配置现在指向本机 LM Studio 的 Gemma 4：

- `AGENT_CORE_MODEL=google/gemma-4-26b-a4b`
- `AGENT_CORE_BASE_URL=http://127.0.0.1:1234/v1`
- `AGENT_CORE_API_KEY=lm-studio`
- `AGENT_CORE_PROMPT_PROFILE=compact`（Gemma 默认自动启用，也可显式覆盖）

当前能力：

- 基于 OpenAI 兼容 API 的多轮 agent loop
- 可配置的并行 tool call 执行语义（LangChain agent graph `v1` / `v2`）
- 本地文件系统与命令工具
- 工作区内 skill source 发现与 skill metadata 暴露
- 基于 `deepagents` task tool 的 multi-agent / handoff
- human-in-the-loop 审批中断
- SQLite checkpoint 持久化
- 基于规则的 input/output guardrails
- 基于 `deepagents` summarization middleware 的 context compaction
- CLI REPL
- 最小 HTTP 服务

## 快速开始

1. 安装依赖

```bash
npm install
```

2. 创建环境变量文件

```bash
cp .env.example .env
```

如果你本机已经在 LM Studio 里把 `Gemma 4 26B A4B` 加载到约 `32K` context，可以直接使用仓库内置的 Gemma 预设：

```bash
npm run serve:gemma-32k
```

或启动 CLI：

```bash
npm run dev:gemma-32k
```

这个预设会读取 `agent-core/.env.gemma-4-32k`，并默认使用：

- `AGENT_CORE_MODEL=google/gemma-4-26b-a4b`
- `AGENT_CORE_PROMPT_PROFILE=compact`
- `AGENT_CORE_CONTEXT_WINDOW_TOKENS_HINT=28000`
- `AGENT_CORE_TEMPERATURE=0`
- `AGENT_CORE_LOG_LEVEL=info`
- `AGENT_CORE_WORKSPACE_MODE=repo`

如果你想覆盖其中某项，可以在运行前先导出环境变量；启动脚本会保留外部显式传入的值。

Gemma 32K 启动脚本现在支持动态工作区模式：

```bash
# 只看 agent-core 仓库本身（默认）
npm run serve:gemma-32k

# 看整个 monorepo 工作区
npm run serve:gemma-32k:workspace

# CLI + 整个工作区
npm run dev:gemma-32k:workspace

# 自定义路径
bash scripts/start-gemma-4-32k.sh serve /absolute/path/to/workspace
```

可用的工作区模式：

- `repo`：工作区固定为 `agent-core/`
- `workspace`：工作区固定为当前 monorepo 根目录
- `/custom/path`：任意自定义绝对路径

你也可以手动设置：

```bash
AGENT_CORE_WORKSPACE_MODE=workspace npm run serve:gemma-32k
AGENT_CORE_WORKSPACE_DIR=/absolute/path npm run serve:gemma-32k
```

如果同时提供 `AGENT_CORE_WORKSPACE_DIR`，它会优先于模式选择，并被视为 `custom`。

3. 如需覆盖默认值，可以配置下面几项

- `AGENT_CORE_MODEL`
- `AGENT_CORE_BASE_URL`
- `AGENT_CORE_API_KEY`
- `AGENT_CORE_PROMPT_PROFILE`
- `AGENT_CORE_WORKSPACE_DIR`
- `AGENT_CORE_WORKSPACE_MODE`
- `AGENT_CORE_AGENT_GRAPH_VERSION`
- `AGENT_CORE_TRACE_LOG_PATH`（可选）
- `AGENT_CORE_MAX_INPUT_CHARS` / `AGENT_CORE_MAX_OUTPUT_CHARS`（可选）
- `AGENT_CORE_SKILL_SOURCE_PATHS`（可选）
- `AGENT_CORE_SUBAGENT_SOURCE_PATHS`（可选）
- `AGENT_CORE_CONTEXT_WINDOW_TOKENS_HINT`（可选）

默认情况下，会话数据会写到 `AGENT_CORE_WORKSPACE_DIR` 下的 `.agent-core/` 目录。

`AGENT_CORE_AGENT_GRAPH_VERSION` 默认是 `v2`。

如果你的 LM Studio local server 已经启动，并且加载了 `google/gemma-4-26b-a4b`，直接使用默认 `.env.example` 就可以跑起来。

为了减轻 Gemma 4 的上下文压力，`agent-core` 现在会在模型名匹配 `gemma` 时默认切到 `compact` prompt profile。这个 profile 会保留 todo、filesystem 和 subagent 能力，但使用更短的 system prompt 和工具描述。

如需手动覆盖：

```bash
AGENT_CORE_PROMPT_PROFILE=default npm run dev
AGENT_CORE_PROMPT_PROFILE=compact npm run dev
```

## CLI 用法

启动交互式 CLI：

```bash
npm run dev
```

Gemma 32K 预设：

```bash
npm run dev:gemma-32k
npm run dev:gemma-32k:workspace
```

可用命令：

- `/help`
- `/skills`
- `/subagents`
- `/thread`
- `/new-thread`
- `/workspace`
- `/quit`

构建后也可以直接运行：

```bash
npm run build
npm start
```

## HTTP 服务

启动本地 HTTP 服务：

```bash
npm run serve
```

Gemma 32K 预设：

```bash
npm run serve:gemma-32k
npm run serve:gemma-32k:workspace
```

构建后启动：

```bash
npm run build
npm run start:http
```

默认监听地址由以下变量控制：

- `AGENT_CORE_HTTP_HOST`，默认 `127.0.0.1`
- `AGENT_CORE_HTTP_PORT`，默认 `8787`

当前路由：

- `GET /health`
- `GET /skills`
- `GET /subagents`
- `GET /traces`
- `GET /traces/:traceId`
- `POST /threads`
- `POST /runs`
- `POST /runs/stream`
- `POST /resume`
- `POST /resume/stream`
- `DELETE /threads/:threadId`

## Web UI

`agent-core/web` 提供了一个基于 `assistant-ui` 的本地浏览器前端，直接复用当前 HTTP / SSE 协议。

当前能力：

- 流式查看模型输出与工具事件
- 在浏览器里处理审批中断
- 查看 skills、subagents、trace id 和最近错误
- 本地多线程切换

启动方式：

```bash
cd packages/agent-core
npm run serve
```

另开一个终端：

```bash
cd packages/agent-core/web
cp .env.example .env.local
npm install
npm run dev -- --host 127.0.0.1 --port 5173
```

然后打开：

```text
http://127.0.0.1:5173
```

如果后端不在默认地址，可以修改 `VITE_AGENT_CORE_BASE_URL`，或者直接在页面侧边栏里改 Base URL。

### 最小示例

健康检查：

```bash
curl http://127.0.0.1:8787/health
```

查看已配置 skill source 和已加载 skills：

```bash
curl http://127.0.0.1:8787/skills
```

查看 general-purpose subagent 和自定义 subagents：

```bash
curl http://127.0.0.1:8787/subagents
```

创建线程：

```bash
curl -X POST http://127.0.0.1:8787/threads \
  -H 'Content-Type: application/json' \
  -d '{}'
```

发起一轮执行：

```bash
curl -X POST http://127.0.0.1:8787/runs \
  -H 'Content-Type: application/json' \
  -d '{
    "threadId": "demo-thread",
    "input": "帮我看看当前目录"
  }'
```

如果返回 `status: "interrupted"`，可以提交审批结果继续执行：

```bash
curl -X POST http://127.0.0.1:8787/resume \
  -H 'Content-Type: application/json' \
  -d '{
    "threadId": "demo-thread",
    "resume": {
      "decisions": [
        { "type": "approve" }
      ]
    }
  }'
```

删除线程 checkpoint：

```bash
curl -X DELETE http://127.0.0.1:8787/threads/demo-thread
```

### Skill System

当前 skill system 直接复用 `deepagents` 的 skill 加载机制，并在 `agent-core` 里补了本地发现与可观测接口。

行为：

- 默认会在工作区下自动发现 `.deepagents/skills`
- 也可以通过 `AGENT_CORE_SKILL_SOURCE_PATHS` 追加一个或多个 skill source 目录
- 所有 skill source 都必须位于 `AGENT_CORE_WORKSPACE_DIR` 内
- CLI 可以通过 `/skills` 查看当前 source 和 skill metadata
- HTTP 可以通过 `GET /skills` 获取同样的信息
- 如果多个 source 中存在同名 skill，后出现的 source 会覆盖前一个 source

配置说明：

- `AGENT_CORE_SKILL_SOURCE_PATHS` 使用逗号、分号或换行分隔
- 路径按相对 `AGENT_CORE_WORKSPACE_DIR` 解析
- 不配置时，如果 `.deepagents/skills` 不存在，则运行时不会加载任何 skills

示例：

```bash
AGENT_CORE_SKILL_SOURCE_PATHS=.deepagents/skills;team-skills
```

### Parallel Tool Calls

当前并行 tool call 语义直接建立在 LangChain agent graph 的版本选择上。

配置项：

- `AGENT_CORE_AGENT_GRAPH_VERSION`

行为：

- `v2` 是默认值
- `v2` 会把单轮中的 tool calls 分发到多个 tool node 执行
- `v1` 保留兼容模式，在单个 tool node 中处理同一轮 tool calls
- `runOnce()`、`resumeOnce()`、HTTP JSON 和 SSE 路径都会统一透传这个设置

说明：

- `agent-core` 不单独实现一套自定义并行执行器
- 并行执行语义交给 LangChain / LangGraph，`agent-core` 负责把它做成明确、稳定、可配置的运行时契约

### Multi-agent / Handoff

当前 multi-agent / handoff 直接复用 `deepagents` 的 `task` subagent tool。

行为：

- general-purpose subagent 默认始终启用
- general-purpose subagent 会继承主 agent 的工具和主 skill source
- 自定义 subagent 默认从工作区下 `.deepagents/subagents` 发现
- 也可以通过 `AGENT_CORE_SUBAGENT_SOURCE_PATHS` 追加一个或多个自定义 subagent source 目录
- CLI 可以通过 `/subagents` 查看 general-purpose 和自定义 subagent
- HTTP 可以通过 `GET /subagents` 获取同样的信息
- 如果多个 source 中存在同名 subagent，后出现的 source 会覆盖前一个 source

自定义 subagent 文件格式：

- 放在 `.deepagents/subagents/*.md`
- 文件正文是 subagent 的 `systemPrompt`
- frontmatter 当前支持：
  - `name`（可选，默认使用文件名）
  - `description`（必填）
  - `model`（可选）
  - `skills`（可选，skill source 路径列表）

示例：

```md
---
description: Research-focused subagent
skills:
  - .deepagents/skills
model: google/gemma-4-26b-a4b
---
You are a research-focused subagent.
Break down complex research tasks, use tools deliberately, and return concise findings.
```

配置说明：

- `AGENT_CORE_SUBAGENT_SOURCE_PATHS` 使用逗号、分号或换行分隔
- 路径按相对 `AGENT_CORE_WORKSPACE_DIR` 解析
- subagent source 和 subagent `skills` 路径都必须位于工作区内
- 不配置时，如果 `.deepagents/subagents` 不存在，则只有 general-purpose subagent 可用

### SSE Streaming

如果你想在客户端里实时消费模型输出和工具事件，可以使用 SSE 路由：

```bash
curl -N -X POST http://127.0.0.1:8787/runs/stream \
  -H 'Content-Type: application/json' \
  -d '{
    "threadId": "demo-thread",
    "input": "帮我看看当前目录"
  }'
```

恢复中断线程时也支持流式输出：

```bash
curl -N -X POST http://127.0.0.1:8787/resume/stream \
  -H 'Content-Type: application/json' \
  -d '{
    "threadId": "demo-thread",
    "resume": {
      "decisions": [
        { "type": "approve" }
      ]
    }
  }'
```

当前 SSE 事件：

- `run_started`
- `text_delta`
- `tool_started`
- `tool_finished`
- `tool_failed`
- `context_compacted`
- `run_interrupted`
- `run_completed`
- `error`

### Tracing / Observability

当前 tracing 默认落到：

- `AGENT_CORE_TRACE_LOG_PATH`
- 未配置时默认是 `.agent-core/traces.jsonl`

普通 JSON run / resume 响应会带 `traceId`，HTTP 头也会返回：

- `X-Agent-Core-Trace-Id`

查询最近 trace：

```bash
curl http://127.0.0.1:8787/traces?limit=20
```

查询单条 trace：

```bash
curl http://127.0.0.1:8787/traces/<trace-id>
```

### Context Compaction

当前实现直接复用 `deepagents` 内建的 summarization middleware。

行为：

- 当上下文接近模型窗口时，旧消息会被压缩成 summary message
- 被压缩掉的历史会被 offload 到工作区下的 `/conversation_history/<session>.md`
- 普通 JSON run / resume 响应会带 `contextCompaction`
- SSE 在本轮发生压缩时会发 `context_compacted`
- trace 中会记录 `context_compacted`

可配置项：

- `AGENT_CORE_CONTEXT_WINDOW_TOKENS_HINT`

说明：

- 这是给 `deepagents` summarization 默认阈值用的窗口 hint
- 不设置时沿用模型自身 profile / deepagents 默认值
- 设置较小值可以让 compaction 更早触发，便于本地调试

示例响应片段：

```json
{
  "traceId": "8f1d...",
  "status": "completed",
  "threadId": "demo-thread",
  "contextCompaction": {
    "sessionId": "session_ab12cd34",
    "cutoffIndex": 18,
    "filePath": "/conversation_history/session_ab12cd34.md",
    "summaryPreview": "You are in the middle of a conversation that has been summarized...."
  }
}
```

### Guardrails

当前 guardrails 在 `service` 层统一生效，所以 CLI、普通 HTTP 和 SSE 流式接口都会共用同一套规则。

可配置项：

- `AGENT_CORE_MAX_INPUT_CHARS`
- `AGENT_CORE_MAX_OUTPUT_CHARS`
- `AGENT_CORE_BLOCKED_INPUT_TERMS`
- `AGENT_CORE_BLOCKED_OUTPUT_TERMS`

说明：

- `AGENT_CORE_BLOCKED_INPUT_TERMS` 和 `AGENT_CORE_BLOCKED_OUTPUT_TERMS` 使用逗号、分号或换行分隔
- 匹配方式是大小写不敏感的子串匹配
- 普通 JSON run / resume 在触发 guardrail 时返回 `422`
- SSE run / resume 在触发 guardrail 时发送 `event: error`

示例：

```bash
AGENT_CORE_MAX_INPUT_CHARS=4000
AGENT_CORE_BLOCKED_OUTPUT_TERMS=api_key,private key,access token
```

### 错误语义

- 非法 JSON 请求体返回 `400`
- 超过大小上限的 JSON 请求体返回 `413`
- 业务字段校验失败返回 `400`
- guardrail 触发返回 `422`

## 测试与验证

```bash
npm run typecheck
npm test
npm run build
```

常用烟测：

```bash
printf '/quit\n' | npm run dev
curl http://127.0.0.1:8787/health
```

## 目录概览

- `src/agent.ts`：运行时组装
- `src/service.ts`：UI 无关的 `runOnce()` / `resumeOnce()` harness
- `src/cli.ts`：CLI 前端
- `src/http.ts`：HTTP adapter
- `src/serve.ts`：HTTP 服务入口
- `src/persistence.ts`：thread 恢复
- `src/hitl.ts`：审批配置
- `src/tracing.ts`：trace 持久化与查询
- `web/`：assistant-ui 前端
- `tests/*.test.ts`：单元测试与集成烟测
- `docs/specs/`：规格文档
- `docs/changes/`：实现说明
- `docs/reviews/`：设计 review
