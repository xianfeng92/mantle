# Twitter Ambient Stage B — AI 处理闭环实施说明

**日期**：2026-04-14  
**Spec**：`docs/specs/2026-04-14-twitter-ambient-spec.md`  
**范围**：Stage B 的 agent-core + Mantle 全部实现，打通 "bookmark ingest → AI 消化 → DB 回写" 链路。

## 关键决策：不走 deepagents subagent 机制

原 Plan 提到用 `.deepagents/subagents/twitter-digest.md` 注册 subagent。实施时放弃这条路：

- Twitter digest 是**纯 request/response 批量转换**，不需要 tool use / multi-step / memory
- gemma 27B 的 tool call 格式（`<|tool_call>...`）需要 `tool-call-fallback.ts` 兜底，稳定性不高
- subagent 走主 agent thread 会污染 checkpoint / audit log

改为：**独立模块 + 直接 `new ChatOpenAI` + prompt 硬约束 + zod 校验 + 一次重试**。代码更少、更稳、更快。

## 变更清单

### agent-core

| 文件 | 作用 |
|---|---|
| **新建** `src/twitter-digest.ts` | 集中管理 schema（zod）、三个 mode 的 system prompt、JSON 提取 helper、带重试的 invoke |
| **修改** `src/http.ts` | import `TwitterDigestRequestSchema` + `generateDigest`；新增 `POST /twitter/digest` handler，放在 `/runs/stream` 之前 |

**三个 mode 的输入/输出协议**：
- `summarize`: 原始推文 ≤20 条 → `items[]` (summary/qualityScore/tags)
- `daily`: 已 summarized 推文 ≤50 条 → `topPicks[]` + `rationale`
- `weekly`: 已 summarized 推文 ≥2 ≤150 条 → `clusters[]` + `orphans[]`

### Mantle

| 文件 | 作用 |
|---|---|
| **修改** `Services/AgentCoreClient.swift` | 新增公开方法 `postJSON<T,B>(path:body:timeout:)`，非 SSE，默认 240s timeout |
| **新建** `Services/TwitterBookmarkDaemon.swift` | `@MainActor` actor，每 15 分钟轮询 `fetchUndigested` → `/twitter/digest` (summarize) → `applyDigest` 回写；`start()`/`stop()`/`triggerNow()`；`generateDailyDigest(date:)` stub（留给 Stage C） |
| **修改** `ViewModels/AppViewModel.swift` | 持有 `twitterBookmarkDaemon`；`startComputerUseServer()` 里一起启动；新增 `triggerTwitterDigestNow()` 供 deep link 调用 |
| **修改** `MantleApp.swift` | `handleDeepLink` 加 `mantle://twitter/digest-now` 路由 |
| **修改** `Mantle.xcodeproj/project.pbxproj` | 注册 `TwitterBookmarkDaemon.swift` |

## Daemon 行为

- **Tick interval 默认 15 分钟**（`tickInterval: 15 * 60`）
- **首次启动立即跑**一次 `processPending()`（tick loop 的第一轮不睡觉）
- **批大小 15**（小于 agent-core schema 上限 20，留余量）
- **并发锁**：`processing: Bool` 标志位防止单次 tick 未完又被 triggerNow 多开
- **线程**：`@MainActor`，与 SwiftData context 一致；HTTP 请求内部走 `AgentCoreClient` actor
- **幂等回写**：response 里的 `id` 与 batch 的 `tweetId` 匹配，miss 打警告不 crash

## 协议总结

### `POST /twitter/digest` (Mantle → agent-core)

请求：
```json
{ "mode": "summarize" | "daily" | "weekly", "bookmarks": [...] }
```

响应（以 `summarize` 为例）：
```json
{ "items": [{ "id": "...", "summary": "...", "qualityScore": 7, "tags": ["..."] }] }
```

错误：400（zod 校验失败）或 500（模型输出仍无法解析，即使重试一次）。

### System Prompt 架构

三份 prompt（SUMMARIZE / DAILY / WEEKLY）共用一段 `BASE_SYSTEM` 强调"JSON ONLY, no prose, no fences, first char must be {"。失败时重试 prompt 追加一条 user message 指出 schema violation。

## 验证结果

### agent-core 侧（命令行 curl 直测）
- ✅ `summarize` (5 条 / 25s)：karpathy 洞见 9、垃圾推文 1、LangGraph 8、CLI tips 7、OpenAI 定价 5
- ✅ `daily` (7 条 / 13s)：topPicks 准确覆盖 ML 方法论 / Agent / RAG / CLI 多样性
- ✅ `weekly` (10 条 / 41s)：3 clusters（AI 模型工程 / 创业商业化 / 研发效能）+ 2 orphans，narrative 中文 2-3 句
- ✅ schema 错误 5 分支（无 mode / 错 mode / 空 bookmarks / 超 20 条 / 缺字段）全 400

### 完整端到端（Chrome 扩展 curl 模拟 → Mantle → agent-core → DB）
- ✅ Stage A 遗留的 2 条 undigested 在 Mantle 新启动时被 Daemon 自动消化
- ✅ 手动 ingest 3 条新推文 → deep link `mantle://twitter/digest-now` 触发 → **8s 内 3 条全部 digestedAt 回写**
- ✅ summary/qualityScore/tags 三字段均按 prompt 约束回填：
  - `@karpathy` "最简模型原则" → 9 `[machine-learning, engineering-principles]`
  - `@andrewyng` "15-30% 提升" → 8 `[prompt-engineering, llm]`
  - `@memelord` meme → 2 `[coding, humor]`

## 工程踩坑记录

1. **Xcode Debug Run 的 Mantle 进程会用 `SIGSTOP` 挂住占端口**：用户按 ⌘. 只是让 LLDB pause，进程不退出，socket 也不释放。后续 `open` / `open -n` 都无法 bind 19816。解决：退出 Xcode 让 LLDB tracer detach，进程才真正死。将来做 e2e 最好用 `open` 直跑构建产物，别用 Xcode debug session。
2. **zsh 的 `kill` builtin 把数字 PID 当成 signal name**：必须用 `/bin/kill -9 <PID>`。
3. **SwiftData 默认存储位置**：`~/Library/Application Support/default.store`，直接 `sqlite3` 可以读（表名前缀 `Z`、列名前缀 `Z`）。
4. **Daemon start() 的 tick loop 第一轮立即跑**（不 `sleep` 再 `tick`）：这意味着应用启动后几秒就会处理历史 undigested，是 feature 不是 bug——对体验友好。

## 下一步

Stage C：通知调度（每晚 22:00 `UNCalendarNotificationTrigger`）、Focus Mode 感知（ContextDaemon 现有能力）、最小 UI（`TwitterDigestListView` 单文件 + Bookmarks tab + 通知点击跳转）。`TwitterBookmarkDaemon.generateDailyDigest` stub 已就位，Stage C 只需把 `NotificationManager.notifyDigestReady(items:)` 接起来。
