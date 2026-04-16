# Mantle Inbox —— Returns Plane 消费端

**Date**: 2026-04-16
**Implements**: `packages/agent-core/docs/specs/2026-04-16-returns-plane-spec.md`

## 背景

Returns Plane 在 agent-core 侧已就绪，`twitter-digest` 的 `daily` / `weekly` 产出会自动进 plane（commits `371f583` + `79341d0`）。本 PR 给 Mantle 桌面客户端加上消费端：菜单栏弹窗里多一个 Inbox 按钮，显示未读数，点开是列表，点每条可标已读。

## 改动

**新增**：

- [Mantle/Models/ReturnsTypes.swift](../../Mantle/Models/ReturnsTypes.swift) —— `ReturnEntry` / `ReturnsListResponse` 等解码类型；`JSONValue` 作为 payload 的 opaque 解码类型，避免各消费者都要声明 schema
- [Mantle/Services/ReturnsService.swift](../../Mantle/Services/ReturnsService.swift) —— `@Observable` `@MainActor` 服务：
  - `start()` → 拉 `GET /returns?unackedOnly=true&limit=100` 并启动 `GET /returns/stream` 订阅
  - SSE 用 `URLSession.bytes.lines` 逐行解析 `event: return.created` / `data: {...}`；指数回退（1s → 30s 封顶）自动重连
  - `ack(_:)` / `ackAllVisible()` / `refreshUnread()`
  - 暴露 `entries` / `unreadCount` / `isStreaming` / `lastError` 给视图
- [Mantle/Views/Inbox/InboxButton.swift](../../Mantle/Views/Inbox/InboxButton.swift) —— 带角标的按钮；点击弹 popover
- [Mantle/Views/Inbox/InboxPopover.swift](../../Mantle/Views/Inbox/InboxPopover.swift) —— 列表 UI：每行 title + summary + 相对时间 + tags；footer 有"Refresh"和"Clear all"
- [MantleTests/ReturnsTypesTests.swift](../../MantleTests/ReturnsTypesTests.swift) —— 解码测试 4 个 case（daily digest / acked entry / list envelope / 任意 JSON payload）

**改动**：

- [Mantle/ViewModels/AppViewModel.swift](../../Mantle/ViewModels/AppViewModel.swift) —— 加 `returnsService` 属性；`init` 末尾 `returnsService.start()`；`reconnect()` 里先 stop 再重建 + start
- [Mantle/Views/MenuBar/PopoverView.swift](../../Mantle/Views/MenuBar/PopoverView.swift) —— header 在"New thread"左边插入 `InboxButton(service: appVM.returnsService)`
- [Mantle.xcodeproj/project.pbxproj](../../Mantle.xcodeproj/project.pbxproj) —— 由 `xcodegen generate` 重新生成；项目 `sources: Mantle` 是递归 glob，新文件自动纳入
- [MantleTests/SSELineParserTests.swift](../../MantleTests/SSELineParserTests.swift) —— `@testable import Cortex` → `@testable import Mantle`（模块更名后的残留）

## 设计要点

- **Inbox 是只读视图，状态由服务器权威**：本地不持久化 entries；App 重启后重新从 `/returns` 拉。这和 Returns Plane spec 的"单一真相源 = 服务端 JSONL"一致
- **ack 语义明确**：`POST /returns/:id/ack` 只写 `ackedAt`，不删除。Inbox 里"已 ack"= 从未读列表消失，但还在 ReturnStore 里可查
- **SSE 重连策略克制**：不做 UI 报错 spam，只在 `lastError` 里埋一行。靠 keep-alive 撑住 idle 连接
- **payload 不硬绑定 schema**：`JSONValue` 让未来新 kind（heartbeat / 其他 ambient workflow）不用改客户端解码路径就能展示 title + summary + tags

## 验证

- `xcodegen generate` ✅（Mantle.xcodeproj 重新生成，新文件入项目）
- `xcodebuild ... build` ✅
- `xcodebuild ... test` → 20/20 ✅（4 new + 16 existing）

## Follow-up（不在本 PR）

- **Deep link 打开原产物**：点 `twitter-digest.daily` 跳到已有 `TwitterDigestListView` 高亮当天；需要给 `ReturnEntry` 定义"跳转意图"或在 payload 里带 route hint
- **announce.channels 消费**：目前所有 entry 都只安静进 Inbox。下一步若 agent-core 侧 dispatch 时带 `announce.channels: ["macos-notification"]`，Mantle 这边要路由到 `NotificationManager`
- **Main window 的完整 Inbox 页**：当前只有菜单栏 popover，未来可以在主窗口 sidebar 加一个 Inbox tab 展示全历史（含已 ack）
