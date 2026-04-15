# Twitter Ambient Stage C — Ambient 推送实施说明

**日期**：2026-04-14  
**Spec**：`docs/specs/2026-04-14-twitter-ambient-spec.md`  
**范围**：Stage C 全部实现 —— 每晚 22:00 自动生成 daily digest 并推送系统通知、Focus Mode 择时、Bookmarks 最小 UI、通知点击回跳。**这是 Mantle 第一次交付"本地模型真正推到用户面前"的体验**。

## 变更清单

### 新建

| 文件 | 作用 |
|---|---|
| `Mantle/Services/DailyDigestScheduler.swift` | 每晚 22:00 触发指定 action 的 Task loop（不用 `UNCalendarNotificationTrigger`，后者只能调度固定内容）。防重入：同一天多次起 Mantle 不重复 fire |
| `Mantle/Views/TwitterDigest/TwitterDigestListView.swift` | 最小 UI。`@Query` 直接订阅 SwiftData，按日期分组，质量徽章（绿/蓝/灰）、tags 单行；`highlightDate` 支持从通知 deep link 过来时高亮当日 |

### 修改

| 文件 | 改动 |
|---|---|
| `Services/NotificationManager.swift` | 新增 `notifyDigestReady(date:items:rationale:)`，body 取前 2 条 `@author｜headline` + `+N more` + rationale；`userInfo["deepLink"]` 带 `mantle://bookmarks?date=YYYY-MM-DD`；`UNUserNotificationCenterDelegate` 点击处理扩展，读 userInfo 后 `NSWorkspace.open(url)` 重新进入自己的 `onOpenURL` 链路 |
| `Services/TwitterBookmarkDaemon.swift` | 填实 `generateDailyDigest(date:)`：① `quietTimeProvider` closure 做 Focus gating（每 60s 轮询，最长 6h 放弃）；② ≤3 条推文跳过 agent-core，直接按 qualityScore 排序；③ >3 条调 `POST /twitter/digest` daily mode；④ 映射 topPicks → `DigestNotificationItem[]` → `NotificationManager.notifyDigestReady` |
| `ViewModels/AppViewModel.swift` | ① 新增 `isQuietTime` 计算属性（不在 Focus Mode 且 `idleSeconds >= 300`）；② 注入 `daemon.quietTimeProvider = { isQuietTime }`；③ 启动 `DailyDigestScheduler(fireHour: 22, fireMinute: 0)`；④ `fireDailyDigestNow()` 调试方法临时绕过 Focus gating |
| `MantleApp.swift` | ① 新增 `Window("Bookmarks", id: "bookmarks")` scene 带 modelContainer；② `@State bookmarksHighlightDate` 从 deep link 带入；③ `handleDeepLink` 新增 `mantle://bookmarks?date=` 和 `mantle://twitter/digest-daily-now` 路由；④ `CommandMenu("Bookmarks")` 加 `⌘⇧B Open` + `⌘⌥D Fire Daily Digest (debug)` + `Request/Test Notification` 调试项 |
| `Mantle.xcodeproj/project.pbxproj` | 注册 `DailyDigestScheduler.swift` + `TwitterDigestListView.swift`（新建 `Views/TwitterDigest` PBXGroup）；**`DEVELOPMENT_TEAM` 从 `VF8KH689D6` 改为 `RZNV72P3RJ`**（详见下文踩坑） |

## Focus Mode gating 设计

Daemon 的 `quietTimeProvider` 是个 `(@MainActor () -> Bool)` closure，**故意不让 Daemon 直接依赖 `ContextDaemon`**。AppViewModel 负责注入：

```swift
daemon.quietTimeProvider = { [weak self] in
    self?.isQuietTime ?? true
}
```

`isQuietTime` = **不在 Focus Mode** AND **idleSeconds ≥ 300**（5 分钟无键鼠）。

轮询策略：
- 22:00 fire 时检查一次，`true` 直接走
- `false` 则每 60s 重试
- **最长等 6 小时**（凌晨 4 点前没等到 quiet 就直接推，避免整夜 Focus 导致漏推）
- `fireDailyDigestNow()` 调试路径**临时绕过 gating**（保存原 provider → 替换为 `{ true }` → defer 还原）

## Critical 踩坑：macOS 通知权限 + 签名

**这个坑占了 Stage C 实施时间的 40%，必须记录**。

### 症状
1. `UNUserNotificationCenter.requestAuthorization` 回调 error：`UNErrorDomain error 1`
2. macOS 系统设置 → 通知 列表里**根本没有 Mantle**
3. 权限对话框从未弹出

### 根因
系统 `usernotificationsd` log 明确写着：
```
[Mantle] Entitlement 'com.apple.private.usernotifications.bundle-identifiers' required
         to request user notifications
[Mantle] requestAuthorization not allowed: com.xforg.Mantle
```

**macOS 14+ 拒绝 ad-hoc signed app 调用 `UNUserNotificationCenter`**。Xcode Debug build 默认给 ad-hoc sign：
```
Signature=adhoc
TeamIdentifier=not set
```

### 诊断路径
1. `codesign -dv --verbose=2 <app>` → 看 `Signature` 和 `TeamIdentifier` 字段
2. `log show --predicate 'process == "usernotificationsd"' --last 5m | grep Mantle` → 看系统层错误
3. `security find-identity -v -p codesigning` → 看 Keychain 里有什么证书
4. `xcodebuild ... -showBuildSettings | grep DEVELOPMENT_TEAM` → 看 pbxproj 配的 team
5. 比对 pbxproj 的 team ID 和证书的 team ID 是否一致

### 修复步骤（未来遇到照抄）
1. **Xcode → Signing & Capabilities → Team** 里选一个有效 team（免费 Personal Team 就够）
2. 如果 pbxproj 里有**历史残留的 team ID**（别人提交上来的 `DEVELOPMENT_TEAM = XXXX`），和你 Keychain 里证书的 team ID 不一致 → 直接改 pbxproj，全局替换为 `security find-identity` 输出括号里的那串
3. `xcodebuild clean && xcodebuild -allowProvisioningUpdates build`
4. `codesign -dv` 确认 `Signature size=NNNN` 和 `Authority=Apple Development: ...` 都出现
5. 启动 Mantle，应该弹 "Mantle would like to send notifications" 对话框，Allow 即可

### 本项目发生了什么
- pbxproj 里继承了 `DEVELOPMENT_TEAM = VF8KH689D6`（前人/旧账号）
- 但当前 Keychain 里证书的 team 是 `RZNV72P3RJ` (18516798133@163.com)
- Xcode 找不到 `VF8KH689D6` 对应的证书 → 悄悄 fallback 到 ad-hoc（没报错）
- 改成 `RZNV72P3RJ` 后，`xcodebuild` 产物仍是 ad-hoc —— 命令行 build 的 cert 选择逻辑可能有坑
- 最终手动 `codesign --force --deep --sign <cert-hash> <app>` 解决。后续 Xcode GUI build 应该能正确签

### 对 Chrome 扩展开发的启示
Stage A 收尾做 Chrome 扩展时，扩展 → localhost:19816 不受签名约束（localhost HTTP 没这个问题），但通知体验需要保证 Mantle 正规签名。**每次 `pkill Mantle && xcodebuild build && open` 之前，必须 `codesign -dv | grep Signature`，一旦 `adhoc` 回来了，立刻重签**。

## 协议总结

### `mantle://twitter/digest-daily-now`（调试）
绕过 Focus gating 立即触发 daily digest。用于测试通知文案 / 点击跳转。

### `mantle://bookmarks?date=YYYY-MM-DD`（通知跳转）
打开 Bookmarks 窗口，`highlightDate` 高亮当日分组 header。`date` 参数可省。

### 通知 userInfo 格式
```json
{ "deepLink": "mantle://bookmarks?date=2026-04-14" }
```

## 验证结果

### UI
- ✅ Bookmarks 窗口正常显示。每行质量徽章（绿 8-10 / 蓝 5-7 / 灰 1-4）、`@author · time`、summary、tags 单行
- ✅ 日期分组 `今天 / 昨天 / M月D日 EEEE`，"今天"带小蓝点 + 蓝字 + count 胶囊
- ✅ 点击推文行打开原 x.com 链接

### 通知
- ✅ `NotificationManager.requestPermission` 在正规签名下成功弹权限对话框
- ✅ `fireDailyDigestNow` 触发后 ~15s 出现横幅通知（gemma daily 推理时间）
- ✅ 点击通知横幅 → `NSWorkspace.open("mantle://bookmarks?date=...")` → `MantleApp.onOpenURL` → `openWindow("bookmarks")` + 高亮当日

### 调度器
- ✅ `DailyDigestScheduler.start()` 启动后，app log 明确输出 `next fire at 2026-04-15 22:00 (in NNNNs)`
- ⏸ 真·22:00 触发未验证（需等一整天）。但 `computeNextFireDate` 已覆盖"今日已过/跨天/跨月"单元逻辑

## 下一步

Stage C 的 UI 属于"最小可用"，可完善但非阻塞。`TwitterDigestListView` 当前直接 `@Query` 全量 bookmarks，没做分页/虚拟列表；数据量 >1000 条会卡。等 Stage D 做 Spotlight 索引时一起优化。

优先级更高的两条路：
- **Stage A 收尾**：fork `prinsss/twitter-web-exporter`，让 Chrome 真正自动抓 x.com bookmarks，替代目前 curl 模拟
- **Stage D**：weekly 聚类报告 + Spotlight 索引（历史搜索）
