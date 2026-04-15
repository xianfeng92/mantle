# twitter-digest → Returns Plane 接入

**Date**: 2026-04-16
**Implements**: `docs/specs/2026-04-16-returns-plane-spec.md` §「与 twitter-digest 的关系」

## 背景

Returns Plane 基础设施已落地（commit `371f583`），但没有真实发布方。`twitter-digest` 作为第一条 ambient workflow，自然是 plane 的首个用户。接入它也验证了 plane 的发布 API 在生产路径上是否好用。

## 改动

**源码**：

- [src/twitter-digest.ts](../../src/twitter-digest.ts)
  - 新增 `buildDigestReturnDraft(request, result)` —— 按 mode 把 digest 结果转成 `ReturnDraft`；`summarize` 返回 `null`（中间产物不持久）
  - 新增 `defaultPersistForMode(mode)` —— `daily` / `weekly` → `true`，`summarize` → `false`
- [src/http.ts](../../src/http.ts) `/twitter/digest`
  - request body 新增可选 `persist?: boolean`；缺省走 `defaultPersistForMode`
  - 当 `persist === true` 且 draft 非 null 时，调用 `returnDispatcher.dispatch`
  - response body 成功 dispatch 后附带 `returnId` 字段

**测试**：

- [tests/twitter-digest.test.ts](../../tests/twitter-digest.test.ts)（新增）
  - `defaultPersistForMode` 三种 mode 的默认值
  - `buildDigestReturnDraft` daily / weekly / summarize(null) / malformed(null) 四个分支

## Return Entry Schema（per kind）

| kind | title | summary | payload |
|---|---|---|---|
| `twitter-digest.daily` | `今日精选 N 条` | rationale 原文 | `{ mode, input (原始已 summarized 推文), output (topPicks + rationale) }` |
| `twitter-digest.weekly` | `本周聚类 N 簇` | clusters 的 `theme (n)` 串 | `{ mode, input, output (clusters + orphans) }` |

Tags：`["twitter-digest", mode, YYYY-MM-DD]`，方便 macOS 客户端做聚合 / 过滤。

## 调用者兼容性

- **旧调用方不显式传 `persist`**：行为按 mode 自动默认（daily/weekly 会开始持久化）——这正是我们想要的默认行为
- **需要关掉**：显式传 `persist: false`
- **需要持久化 summarize**：显式传 `persist: true`，但 `buildDigestReturnDraft` 对 `summarize` 返回 null，目前不会真的 dispatch。如果真需要，再扩 `buildDigestReturnDraft`

## 验证

- `npm run typecheck` ✅
- `tests/twitter-digest.test.ts` 5/5 ✅
- `tests/returns.test.ts` + `tests/http.test.ts` 26/26 ✅

## Follow-up

- Mantle macOS 客户端菜单栏 Inbox —— 现在有了真实数据源，可以开始做（roadmap #2）
- `announce.channels` 策略 —— 目前所有 digest draft 都不带 announce（只存档不打扰），和 ZeroClaw 的默认克制一致。如果用户反馈"希望每天早 8 点收到提醒"，再加 `announce` 字段和 macOS 通知路径
