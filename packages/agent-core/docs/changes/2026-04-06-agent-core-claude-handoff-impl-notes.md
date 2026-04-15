---
title: Agent Core Claude Handoff Notes
status: implemented
owner: codex
created: 2026-04-06
updated: 2026-04-06
implements:
  - CLAUDE.md
reviews: []
---

# Agent Core Claude Handoff Notes

## 1. 当前项目状态

`agent-core` 当前是可运行状态，活跃实现为 `TypeScript + deepagentsjs`。

已经完成的主线能力：

- CLI harness
- 通用 service harness
- HTTP / SSE 服务
- tracing / observability
- guardrails
- context compaction
- skills / subagents / multi-agent handoff
- `assistant-ui` Web UI
- Gemma 4 默认接入
- Gemma 4 `compact` prompt profile

## 2. 当前默认运行环境

- 模型：`google/gemma-4-26b-a4b`
- API endpoint：`http://127.0.0.1:1234/v1`
- API key：`lm-studio`
- prompt profile：`compact`
- HTTP 服务：`http://127.0.0.1:8787`
- Web UI：`http://127.0.0.1:5173`

默认情况下，只要本机 LM Studio server 已启动并加载了 Gemma 4，项目不依赖额外 `.env` 也可以直接运行。

## 3. 已确认的运行坑点

### 3.1 Gemma 4 上下文压力

在 LM Studio 下，Gemma 4 对上下文长度比较敏感。之前已经出现过这类错误：

- `n_keep >= n_ctx`
- `Context size has been exceeded`

实际处理经验：

- 不要先怀疑 Web UI 或 HTTP 服务
- 先检查 LM Studio 是否把模型加载成了足够大的 context
- 当前建议至少使用 `32768` context

### 3.2 Prompt 负担优化

为了减轻 Gemma 4 的上下文压力，运行时已经新增 `compact` prompt profile：

- Gemma 模型默认自动启用 `compact`
- 也可以用 `AGENT_CORE_PROMPT_PROFILE=default|compact` 手动覆盖
- 该 profile 保留 todo、filesystem、subagent 能力，但使用更短的 system prompt 和工具描述

相关代码：

- `src/settings.ts`
- `src/system-prompt.ts`
- `src/agent.ts`

## 4. 建议 Claude 的阅读顺序

1. `README.md`
2. `docs/specs/2026-04-05-agent-core-design-spec.md`
3. `docs/reviews/2026-04-05-agent-core-design-review.md`
4. 本文档
5. `web/README.md`

如果要改核心运行时，优先看：

- `src/agent.ts`
- `src/service.ts`
- `src/http.ts`
- `src/settings.ts`
- `src/system-prompt.ts`

## 5. 常用启动与验证命令

安装依赖：

```bash
cd /Users/xforg/AI_SPACE/agent-core
npm install
```

CLI：

```bash
npm run dev
```

HTTP：

```bash
npm run serve
```

Web UI（单独）：

```bash
cd /Users/xforg/AI_SPACE/agent-core/web
npm install
npm run dev -- --host 127.0.0.1 --port 5173
```

一键启动后端 + Web UI：

```bash
npm run dev:all
```

验证：

```bash
cd /Users/xforg/AI_SPACE/agent-core
npm run typecheck
npm test
npm run build
printf '/quit\n' | npm run dev
curl http://127.0.0.1:8787/health
```

## 6. 最近关键提交

- `28942e1` `Add compact prompt profile for Gemma 4`
- `d15fcd0` `Default agent-core to Gemma 4 on LM Studio`
- `5df3ae6` `Expand agent-core runtime and add web UI`
- `fcccca2` `Add tracing and observability to agent-core`
- `f98b7a1` `Polish agent-core onboarding and smoke coverage`
- `e9d6a44` `Add minimal HTTP service for agent-core`
- `1bb7faf` `Extract agent-core service harness`
- `9ea0528` `Persist agent-core sessions with SQLite`

## 7. 建议的下一步方向

当前不建议大规模重写架构，优先做增量改进。

更值得继续推进的方向：

- 优化 Gemma 4 在 LM Studio 下的长期稳定性
- 继续压缩 prompt / tool schema 的 token 开销
- 补更真实的端到端 smoke / UI 自动化验证
- 改善 Web UI 的可用性和调试体验

暂时不建议优先推进：

- Kotlin / Android 版本实现
- 重新引入 Python MVP

## 8. 交接建议

如果 Claude 接手后做了下列任一类改动，建议同步更新文档：

- 修改默认模型或默认 prompt profile
- 修改 HTTP 协议或 `/health` 返回格式
- 修改 Web UI 启动方式
- 修改审批流、trace、streaming、compaction 的默认行为

最少更新一处：

- `README.md`
- `docs/changes/*.md`
