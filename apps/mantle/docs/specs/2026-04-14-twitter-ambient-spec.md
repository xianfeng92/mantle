---
title: "Mantle × Twitter Ambient 阅读系统"
status: ready
owner: claude
created: 2026-04-14
updated: 2026-04-14
implements: []
reviews: []
---

# Mantle × Twitter Ambient 阅读系统

## Context（为什么做这件事）

**现状瓶颈**：Mantle 作为本地 26B gemma 模型的桌面前端，现有功能"有但少用"。本地模型的真正护城河在三件事上：**免费+无限跑、隐私、低延迟**；脱离这三条就打不过 Claude API。

**具体痛点**：用户在 Twitter/X 上 mark（like/bookmark）大量推文但从不回看——经典的"信息过载 + 注意力碎片"场景。

**解法定位**：把 Mantle 做成 **"Ambient 阅读消费系统"**。内容不等你回去看，而是按你的节奏找你——每晚通知 push 精选、Focus Mode 择时、Spotlight 语义回忆。

**差异化**：已有 Siftly / Smaug / Karakeep 等项目做 bookmark 管理，Mantle **不做第 N 个管理器**，只做它们做不了的"推到桌面前"——通知 / Spotlight / ⌥Space 问答。UI 浏览器缩到最小。

**预期效果**：每天晚上 22:00，Mantle 从当天 mark 的推文中挑 5–7 条真正值得读的推通知；每周日晚生成主题脉络周报；随时用 Spotlight 检索历史 mark。

---

## 架构三件套

```
┌────────────────────┐    POST /bookmarks/ingest    ┌─────────────────┐
│ Chrome 扩展         │ ───────────────────────────> │ Mantle (macOS)  │
│ (fork twitter-web- │    localhost:19816           │                 │
│  exporter)         │                              │ - SwiftData     │
│ - GraphQL 拦截     │                              │ - Daemon 调度    │
│ - Bookmark 捕获    │                              │ - 22:00 通知     │
└────────────────────┘                              │ - Spotlight     │
                                                     │ - 最小 UI       │
                                                     └────────┬────────┘
                                                              │ POST /twitter/digest
                                                              ▼
                                                     ┌─────────────────┐
                                                     │ agent-core      │
                                                     │ (localhost:8787)│
                                                     │ - subagent      │
                                                     │ - gemma3 27B    │
                                                     └─────────────────┘
```

---

## Stage A — 数据管道贯通

**目标**：Chrome 扩展捕获 bookmark → Mantle 落库；不做 AI 处理。

**任务**：
1. Fork [`prinsss/twitter-web-exporter`](https://github.com/prinsss/twitter-web-exporter) 到 `Mantle/extensions/twitter-capture/`，保留 GraphQL interceptor 模块，裁掉 UI/导出逻辑
   - 改造：只保留 bookmark 相关端点拦截（`CreateBookmark` mutation + `Bookmarks` query），成功后 POST 到 `http://127.0.0.1:19816/bookmarks/ingest`
   - options 页显示 Mantle 连接状态 + "一次性导入当前 bookmarks 页"按钮（冷启动用）
2. Mantle 侧：
   - `Mantle/Models/PersistentModels.swift` 追加 `@Model TwitterBookmark`
   - 新建 `Mantle/Services/TwitterBookmarkStore.swift`
   - `Mantle/Services/ComputerUseServer.swift` 新增 `POST /bookmarks/ingest` + `GET /bookmarks/status` 路由；带 `X-Mantle-Token` header 校验（token 写入 `~/Library/Application Support/Mantle/extension-token`）

**验证**：x.com 点 bookmark → `curl /bookmarks/status` count+1 → SwiftData db 有新行。

---

## Stage B — AI 处理闭环

**目标**：bookmark 进来后 24h 内拿到 summary / qualityScore / tags。

**任务**：
1. agent-core：
   - `.deepagents/subagents/twitter-digest.md` subagent 定义
   - `agent-core/src/http.ts` 参照 `POST /runs`（line 838）新增 `POST /twitter/digest`（一次性 response 非 SSE）
   - 新建 `agent-core/src/twitter-digest/parser.ts` zod 校验 + 一次重试
2. Mantle：
   - 新建 `Mantle/Services/TwitterBookmarkDaemon.swift`（独立 actor）每 15 分钟 `processPending()`
   - `AgentCoreClient` 新增 `postJSON<T: Decodable>(path:body:)` 非 SSE 方法
   - `MantleApp/AppViewModel` 启动时注入 Daemon

**验证**：`curl /twitter/digest -d @sample.json` 拿到合法 JSON；Daemon tick 后 DB summary 被填。

---

## Stage C — Ambient 推送（核心差异化）

**目标**：每晚 22:00 系统通知 push digest；点通知跳到最小 UI。

**任务**：
1. `NotificationManager` 扩展：
   - `scheduleNightlyDigest()` — `UNCalendarNotificationTrigger` hour=22 min=0
   - `notifyDigestReady(items:)` — title "今日 Twitter 精选 (N)"
   - debug `fireDigestNow()` 绑 `⌘⇧D`
2. `TwitterBookmarkDaemon.generateDailyDigest(date:)` — 调 agent-core mode=`daily`
3. Focus Mode 感知：22:00 若在 Focus Mode → 延后到 Focus Mode 退出后 >5min 无键鼠的"第一个空闲时刻"
4. 最小 UI：`TwitterDigestListView.swift` 单文件按日期分组 list；`MainWindowView` 加 "Bookmarks" tab；通知点击切 tab

**验证**：`⌘⇧D` 立即触发 → macOS 通知；点击打开 Bookmarks tab；Focus Mode 下触发应被延后。

---

## Stage D — 周报 + Spotlight

**目标**：周日晚主题聚类周报 + 历史 mark 可 Spotlight 搜。

**任务**：
1. agent-core `mode: "weekly"` 分支：输入当周 qualityScore≥6 的 bookmarks，输出 clusters
2. `TwitterBookmarkDaemon.generateWeeklyReport()` — 周一 weekday=1 hour=22 min=30
3. `SpotlightService.indexBookmark(_:)` — domain `com.mantle.twitter.bookmarks`；`mantle://bookmark/{tweetId}` URL scheme 路由
4. 周报通知点击显示聚类分组

**验证**：`mdfind "@handle"` 能搜到；周日晚通知出现，点开看 cluster 分组。

---

## 关键协议

### Chrome → Mantle (`POST /bookmarks/ingest`)
```json
{
  "tweetId": "1234567890",
  "url": "https://x.com/user/status/1234567890",
  "author": "@handle",
  "text": "推文正文",
  "quotedText": "引用推文（可选）",
  "mediaUrls": ["https://..."],
  "capturedAt": "2026-04-14T15:30:00Z"
}
```
Headers: `X-Mantle-Token: <token>`  
Response: `{"ok": true, "deduped": false}`

### Mantle → agent-core (`POST /twitter/digest`)
Request: `{"mode": "summarize"|"daily"|"weekly", "bookmarks": [{"id","author","text","quotedText"}]}`

- summarize resp: `{"items":[{"id","summary":"≤60字","qualityScore":1-10,"tags":["..."]}]}`
- daily resp: 上面 + `{"topPicks":["id1",...],"rationale":"..."}`
- weekly resp: `{"clusters":[{"theme","bookmarkIds":[],"narrative":"2-3句"}],"orphans":[]}`

### `twitter-digest.md` system prompt 核心约束
```
Role: Twitter bookmark curator for a tech-savvy Chinese/English bilingual reader.
Input: JSON array of bookmarks.
Output: STRICT JSON only — no prose, no markdown fences, no explanation.
Rules:
- summary: ≤60 Chinese chars (or 40 English words), capture the insight not the topic
- qualityScore: 10=rare insight/data, 5=decent, 1=joke/noise
- tags: 1-3 lowercase kebab-case
- daily topPicks: pick 3-5 highest, prefer topic diversity
- weekly clusters: merge by semantic theme, ≥2 bookmarks per cluster
If input >20 items, process ALL, do not truncate.
```

---

## 复用 & 参考

**直接抄/fork**：`prinsss/twitter-web-exporter`（MIT，GraphQL 拦截）、`sahil-lalani/bookmark-export`（MV3 参考）

**只借鉴 prompt**：`alexknowshtml/smaug`、`viperrcrypto/Siftly`

**Mantle 复用**：`ComputerUseServer`（端口 19816 加路由）、`AgentCoreClient/SSEStreamClient`、`SpotlightService`（加 domain）、`PersistentModels` `@Model` 模式、`ContextDaemon` Focus Mode 检测、`NotificationManager`

**agent-core 复用**：`src/agent.ts` gemma 调用、`.deepagents/subagents/` 机制、`src/http.ts` `POST /runs` 模板、`src/tool-call-fallback.ts` JSON 提取

---

## 风险与未决

| 风险 | 应对 |
|---|---|
| X.com GraphQL endpoint 名字会变 | 扩展里抽 config，定期从 upstream rebase |
| gemma 27B 批量 JSON 不稳 | prompt 硬约束 + zod 校验 + 一次重试；单批≤15 条 |
| weekly 输入过大 | 先过滤 qualityScore≥6；超 150 条分批 summarize |
| localhost:19816 无鉴权 | `X-Mantle-Token` header + 文件落盘 |
| 冷启动历史数据 | 扩展 options 页手动扫描当前 bookmarks 页 |
| Focus Mode 退出"空闲时刻" | 复用 ContextDaemon idle 检测；>5min 无键鼠 |

---

## Critical Files

**新建**：
- `Mantle/extensions/twitter-capture/` (fork)
- `Mantle/Services/TwitterBookmarkStore.swift`
- `Mantle/Services/TwitterBookmarkDaemon.swift`
- `Mantle/Views/TwitterDigest/TwitterDigestListView.swift`
- `agent-core/.deepagents/subagents/twitter-digest.md`
- `agent-core/src/twitter-digest/parser.ts`

**修改**：
- `Mantle/Models/PersistentModels.swift` — 追加 `TwitterBookmark`
- `Mantle/Services/ComputerUseServer.swift` — 加 2 个路由
- `Mantle/Services/AgentCoreClient.swift` — 加 `postJSON`
- `Mantle/Services/NotificationManager.swift` — 加 digest + schedule
- `Mantle/Services/SpotlightService.swift` — 加 bookmark domain
- `Mantle/Services/ContextDaemon.swift` — 暴露 Focus Mode exit hook
- `Mantle/Views/MainWindow/MainWindowView.swift` — 加 Bookmarks tab
- `Mantle/MantleApp.swift` — 注册 daemon + 通知点击 handler
- `agent-core/src/http.ts` — 加 `POST /twitter/digest`

---

## 验证方案（端到端）

**手动 e2e**：
1. 启动 LM Studio 加载 gemma3 27B
2. 启动 agent-core
3. 启动 Mantle（Xcode Debug Run）
4. 安装 Chrome 扩展，options 页粘贴 token
5. 打开 x.com，真实 bookmark 5 条不同质量推文
6. 等最多 15 min 或手动 `processPending()`
7. `⌘⇧D` fire digest → 看通知
8. 点通知 → Bookmarks tab 看 list
9. Spotlight 搜作者 handle → 看到结果

**单点测试**：
- Stage A: `curl -X POST 127.0.0.1:19816/bookmarks/ingest -d @tests/fixtures/sample-bookmark.json -H "X-Mantle-Token: xxx"`
- Stage B: `curl -X POST 127.0.0.1:8787/twitter/digest -d @tests/fixtures/twitter-digest-5items.json`
- Stage D: `tests/fixtures/twitter-week-30items.json` 肉眼验聚类

**调试工具**：Chrome `chrome://extensions` background page、Mantle `os_log` subsystem `com.mantle.twitter`、agent-core 现有 log。
