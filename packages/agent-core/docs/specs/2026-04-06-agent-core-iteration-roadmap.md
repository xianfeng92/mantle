---
title: Agent Core 迭代路线图（稳定性优先 · 小步快跑）
status: implemented
owner: claude
created: 2026-04-06
updated: 2026-04-08
implements:
  - agent-core/docs/changes/2026-04-06-agent-core-claude-handoff-impl-notes.md
  - Mantle/docs/changes/2026-04-08-m3-hotkey-audit-rollback-impl-notes.md
reviews: []
---

# Agent Core 迭代路线图（稳定性优先 · 小步快跑）

## Context

agent-core 已完成 MVP+ 交付（TypeScript + deepagentsjs），功能完整可运行。用户定位为**框架研究/学习 + 产品原型**，当前只用 Gemma 4（本地 LM Studio）。最大痛点是 Gemma 4 的稳定性——tool call 解析可能失败、连接中断无重试、上下文溢出无自动恢复。

迭代策略：**每次 1-2 个改进，快速验证，先稳定后体验**。

---

## 迭代总览

| # | 主题 | 优先级 | 关键文件 | 依赖 |
|---|------|--------|---------|------|
| 1 | Gemma 4 tool call fallback（完整闭环） | P1 | 新建 `src/tool-call-fallback.ts`，改 `src/service.ts` | 无 |
| 2 | LM Studio 连接重试 | P2 | 新建 `src/retry.ts`，改 `src/service.ts` | 无 |
| 3 | Context benchmark + 溢出自动恢复 | P2 | 新建 `tests/benchmarks/`，改 `src/service.ts`、`src/compaction.ts` | #2 |
| 4 | Web UI 线程持久化 | P3 | `web/src/hooks/use-agent-core-app.ts` | 无 |
| 5 | 工程清理 | P3 | `.gitignore`、spec frontmatter、changelog | 无 |
| 6 | Gemma 4 诊断面板 | P3 | `src/tracing.ts`、`src/http.ts` | #1-3 |

#1、#2、#4、#5 互相独立。#3 依赖 #2。#6 依赖 #1-3。
Context 后续优化（预防性压缩、可视化、压缩质量）根据 #3 的 benchmark 数据决定。

---

## Iteration 1: Gemma 4 Tool Call Fallback

**目标**：当 LM Studio 没有正确解析 Gemma 4 的 `<|tool_call>` 格式时，在 service 层自动检测并修复。

**核心要求**：Fallback 必须是完整闭环，不只是"检测到 tool call"就结束，而是：
1. 解析出 tool call → 2. 修补 AIMessage 使其带有正确的 `tool_calls` → 3. 让 LangGraph 正常执行工具 → 4. tool result 作为 ToolMessage 反馈给模型 → 5. 模型继续推理

**改动**：

1. **新建 `src/tool-call-fallback.ts`**（~100 LOC）
   - `extractFallbackToolCalls(content: string)` — 解析 `<|tool_call>call:funcName{...}<tool_call|>` 格式
   - `patchMessageWithFallbackToolCalls(message: BaseMessage)` — 当 `tool_calls` 为空但 content 包含 tool call 模式时，构造带有正确 `tool_calls` 字段的 AIMessage（包括 `id`、`name`、`args`），确保下游 LangGraph 工具执行节点能正常接管
   - 清理 content 中的原始 `<|tool_call>...<tool_call|>` 标记，避免模型下轮看到残留
   - 处理多个 tool call、嵌套参数、畸形格式（graceful no-op）

2. **改 `src/service.ts`**
   - `executeLoop`：invoke 返回后，对最后一条 AIMessage 做 fallback 检查；如果修补成功，**将修补后的 message 写回 state**，让 LangGraph 的工具执行节点在下一轮循环中正常处理（即：工具被执行 → result 反馈给模型 → 模型继续）
   - `executeStream`：流结束时对最终结果做同样检查和修补
   - 不改 deepagentsjs 核心，只是 post-processing + state 注入

3. **新建 `tests/tool-call-fallback.test.ts`**
   - 单个/多个 tool call 提取
   - 提取后 AIMessage 的 `tool_calls` 结构验证（id、name、args 完整）
   - content 残留清理验证
   - 无 tool call 内容（返回 null，passthrough）
   - 畸形格式（不崩溃）
   - 集成场景：修补后的 message 能被 LangGraph 工具节点识别

**验证**：
```bash
npm run typecheck && npm test
```
手动：让 Gemma 4 触发工具调用，确认：
- LM Studio 正常解析时：fallback 不干预，正常流程
- LM Studio 未正确解析时：fallback 提取 tool call → 工具被执行 → 结果反馈给模型 → 模型基于结果继续回复

---

## Iteration 2: LM Studio 连接重试

**目标**：LM Studio 短暂不可用（启动中、过载、网络抖动）时自动重试，而非直接报错。

**改动**：

1. **新建 `src/retry.ts`**（~70 LOC）
   - `withRetry<T>(fn, options)` — 指数退避重试
   - `isTransientLmStudioError(error)` — 识别 ECONNREFUSED / ETIMEDOUT / 502-504
   - `isContextSizeExceededError(error)` — 识别 context 溢出（本轮不重试，为 #3 做准备）

2. **改 `src/service.ts`**
   - `executeLoop` 的 invoke 调用用 `withRetry` 包裹（最多 3 次，1s/2s/4s）
   - `executeStream` 的初始连接同理
   - 重试时写 trace 日志

3. **新建 `tests/retry.test.ts`**
   - 首次成功 / 重试后成功 / 耗尽重试 / 不可重试错误

**验证**：
```bash
npm run typecheck && npm test
```
手动：停掉 LM Studio，发消息，观察 3 次重试后报清晰错误。重启 LM Studio 恢复正常。

---

## Iteration 3: Context Benchmark + 最小可用恢复

**目标**：先建立可量化的 context 管理 benchmark，再基于数据做最小可用的溢出恢复。

### 3a. Context Benchmark 框架

**为什么先做这个**：Context 管理涉及预防性压缩、溢出恢复、压缩质量等多个优化点。不建 benchmark 就加功能，无法判断是改善了还是恶化了。

**改动**：

1. **新建 `tests/benchmarks/context-benchmark.ts`**（~150 LOC）
   - 不是单元测试，是独立的评估脚本（`npm run bench:context`）
   - 核心指标：

   | 指标 | 定义 | 测量方式 |
   |------|------|---------|
   | **对话深度** | 溢出前能跑多少轮有效对话 | 自动化多轮 prompt loop，计数到报错 |
   | **压缩信息保留率** | 压缩后模型是否还记得之前的关键事实 | 压缩后提问 5 个之前对话中的事实，正确率 |
   | **恢复成功率** | 溢出后自动恢复成功的比例 | 触发 N 次溢出，统计恢复成功数 |
   | **Token 效率** | 每轮对话消耗的平均 token 数 | 累计 token / 对话轮数 |
   | **端到端延迟** | 压缩 / 恢复操作的额外耗时 | 有压缩 vs 无压缩的响应时间差 |

   - 输出 JSON 报告到 `.agent-core/benchmarks/context-<timestamp>.json`
   - 支持 `--dry-run` 模式（使用 mock model，不需要 LM Studio）

2. **`package.json`** 新增 script：
   ```json
   "bench:context": "tsx tests/benchmarks/context-benchmark.ts"
   ```

### 3b. 溢出自动恢复（最小可用）

**改动**：

1. **改 `src/service.ts`**
   - `withRetry` 耗尽且 `isContextSizeExceededError` 为 true 时，不立即抛错
   - 调用现有 `createSummarizationMiddleware` 触发压缩
   - 压缩后重试原请求一次
   - 仍失败则抛出清晰错误

2. **改 `src/compaction.ts`**
   - 导出 `buildCompactionHint()` 辅助函数

3. **跑一次 benchmark**：记录"溢出恢复"的基线数据

**验证**：
```bash
npm run typecheck && npm test
npm run bench:context -- --dry-run   # 快速验证 benchmark 脚本本身
npm run bench:context                # 需要 LM Studio，产出基线报告
```

### 后续 Context 迭代（根据 benchmark 数据决定）

以下功能**不在本轮实现**，等 benchmark 基线数据出来后，根据数据决定优先级：

- **预防性压缩**（在接近上限时主动压缩）— 如果 benchmark 显示溢出频率高，优先做
- **压缩质量优化**（更好的摘要 prompt）— 如果 benchmark 显示信息保留率低，优先做
- **Context 用量可视化**（Web UI / CLI）— 如果用户需要感知 context 状态，优先做
- **可配置 context 上限**— 如果不同场景需要不同配置，优先做

每个优化做完后重跑 benchmark，对比改善幅度。

---

## Iteration 5: Web UI 线程持久化

**目标**：刷新浏览器不丢线程和消息历史。

**改动**：

1. **改 `web/src/hooks/use-agent-core-app.ts`**
   - `THREADS_STORAGE_KEY = "agent-core-web.threads"`
   - `createInitialThreadState` 优先从 localStorage 恢复
   - `useEffect` 监听 `threadsById` 变化，序列化到 localStorage
   - 数据损坏时 graceful fallback 到空状态
   - 新增 `clearAllThreads()` action

**验证**：
- 打开 Web UI，创建线程，发消息，刷新浏览器 → 线程和消息仍在
- DevTools 检查 localStorage 数据结构
- 手动破坏 localStorage 值，刷新 → 优雅降级到空状态

---

## Iteration 6: 工程清理

**目标**：一次性解决 3 个 P3 杂项。

1. **`.gitignore`** — 添加 `agent-core/web/node_modules/`
2. **`docs/specs/2026-04-05-agent-core-design-spec.md`** — frontmatter 改为 `status: implemented`，注明 TypeScript pivot
3. **新建 `docs/changes/2026-04-06-agent-core-housekeeping-notes.md`** — 记录 TS 版本差异说明（root 6.0 vs web 5.9，Vite 兼容性原因，非 bug）

**验证**：
```bash
npm run typecheck && npm test
git status  # web/node_modules 不再出现
```

---

## Iteration 6: Gemma 4 诊断端点

**目标**：一键查看 Gemma 4 运行状况——fallback 触发次数、重试次数、context 恢复次数。为下一大迭代（可观测性）打基础。

**改动**：

1. **`src/tracing.ts`** — 扩展 trace event kinds：`tool_call_fallback`、`retry_attempted`、`context_recovery`
2. **`src/service.ts`** — 在 #1-3 的各个路径写入对应 trace 事件
3. **`src/http.ts`** — 新增 `GET /diagnostics`，读最近 N 条 trace，返回统计摘要

**验证**：
```bash
npm run typecheck && npm test
curl http://127.0.0.1:8787/diagnostics
```

---

## 下一大迭代预告：可观测性（Observability）

> 本轮不实现，但作为下一个迭代周期的核心主题记录在此。

**核心需求**：请求链路追踪（类 LangSmith 本地版）

每次用户请求的完整链路可视化：
```
用户输入
  → 模型推理（耗时、token 消耗）
    → 工具选择（为什么选了这个工具）
      → 工具执行（输入、输出、耗时）
        → 结果反馈模型
          → 最终回复
```

**可能的子主题**：
- 结构化 trace 格式（OpenTelemetry-compatible 或自定义 spans）
- Token 用量统计（每轮、累计、模型调用次数）
- 延迟分解（模型推理 vs 工具执行 vs 网络）
- 决策可视化（模型的 reasoning 过程）
- 展现形式待定（Web UI 内嵌 / 独立 trace 浏览器 / CLI）

**前置条件**：Iteration 1-3 完成后，trace 系统已有 fallback/retry/recovery 事件，可以在此基础上扩展。
