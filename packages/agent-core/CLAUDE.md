# Agent Core — Claude 指令

## 项目定位

`agent-core/` 是一个本地开发 agent 运行时项目，当前活跃实现为 `TypeScript + deepagentsjs`。
它同时提供：

- CLI REPL
- 最小 HTTP / SSE 服务
- 基于 `assistant-ui` 的本地 Web UI

默认模型路线是本机 LM Studio 的 Gemma 4。

## 当前实现基线

- 运行时语言：TypeScript / Node.js
- agent 基座：`deepagentsjs`
- 默认模型：`google/gemma-4-26b-a4b`
- 默认 OpenAI-compatible base URL：`http://127.0.0.1:1234/v1`
- 默认 prompt profile：`compact`
- 默认 HTTP 服务：`127.0.0.1:8787`
- 默认 Web UI：`127.0.0.1:5173`

重要：

- 不要再把项目往旧 Python MVP 路线拉回去，Python 原型已移除
- Gemma 4 在 LM Studio 下对上下文长度比较敏感，实际使用时建议 context 至少 `32768`
- 当前仓库通常不需要实际 `.env` 文件也能跑；若 LM Studio 已启动，默认值即可工作

## 项目结构

```text
agent-core/
├── CLAUDE.md
├── README.md
├── package.json
├── src/
│   ├── agent.ts
│   ├── service.ts
│   ├── http.ts
│   ├── cli.ts
│   ├── settings.ts
│   ├── system-prompt.ts
│   ├── guardrails.ts
│   ├── compaction.ts
│   ├── tracing.ts
│   ├── skills.ts
│   ├── subagents.ts
│   └── ...
├── tests/
├── docs/
│   ├── specs/
│   ├── changes/
│   └── reviews/
└── web/
    ├── README.md
    └── src/
```

## 阅读顺序

Claude 接手时，建议按这个顺序读：

1. `README.md`
2. `docs/specs/2026-04-05-agent-core-design-spec.md`
3. `docs/reviews/2026-04-05-agent-core-design-review.md`
4. `docs/changes/2026-04-06-agent-core-claude-handoff-impl-notes.md`
5. `web/README.md`

如果要直接改运行时，优先看这些文件：

- `src/agent.ts`
- `src/service.ts`
- `src/http.ts`
- `src/settings.ts`
- `src/system-prompt.ts`

## 本项目协作规则

- 当任务涉及 `agent-core/` 内文件时，优先遵守本文件，而不是只看根目录指令
- 新 spec 写入 `docs/specs/`
- 实现说明、迁移说明、handoff 备注写入 `docs/changes/`
- review 结论写入 `docs/reviews/`
- 不要把重要设计决策只留在对话里，至少同步到 `README.md` 或 `docs/changes/`

## 运行与验证

安装依赖：

```bash
cd packages/agent-core
npm install
```

启动 CLI：

```bash
npm run dev
```

启动 HTTP 服务：

```bash
npm run serve
```

启动 Web UI（单独）：

```bash
cd packages/agent-core/web
npm install
npm run dev -- --host 127.0.0.1 --port 5173
```

一键启动后端 + Web UI：

```bash
npm run dev:all
```

常用验证：

```bash
cd packages/agent-core
npm run typecheck
npm test
npm run build
printf '/quit\n' | npm run dev
curl http://127.0.0.1:8787/health
```

## 当前默认行为

- Gemma 模型默认自动走 `compact` prompt profile
- `GET /health` 会返回 `model` 和 `promptProfile`
- CLI banner 会显示当前 `Prompt profile`
- `humanInTheLoop` 保护 `write_file`、`edit_file`、`execute`
- 会话和 checkpoint 落到 `.agent-core/`
- traces 落到 `.agent-core/traces.jsonl`

## 已完成的大项

- service harness：`runOnce()` / `resumeOnce()` / streaming
- HTTP / SSE 服务
- tracing / observability
- guardrails
- context compaction
- skills / subagents / multi-agent handoff
- `assistant-ui` Web UI
- Gemma 4 默认接入
- Gemma 4 `compact` prompt profile

## 当前优先级建议

- 优先做增量改进，不要大改架构
- 如果继续优化 Gemma 4，优先关注：
  - 更轻的工具描述
  - 更稳的长上下文表现
  - 更好的 LM Studio 运行体验
- Kotlin / Android 版本不是当前 blocker，不必优先推进

## 注意事项

- 如果 `8787` 被占用，不要杀掉用户现有服务，优先临时换端口验证
- 如果 Gemma 4 出现 `context size exceeded`，先检查 LM Studio 的模型 context 设置，而不是先改代码
- 如果修改了运行时默认行为，记得同步更新 `README.md` 和 `docs/changes/`
