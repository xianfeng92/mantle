# Context Daemon M1 + M2 实施记录

**日期**: 2026-04-07
**作者**: Claude
**对应 spec**: Aura 设计文档 M2/M3 → 重编号为 Mantle M1/M2

## 决策

不新建 Aura 项目，在 Mantle 现有架构上直接扩展环境感知能力。保持 agent-core + LM Studio 后端不变。

## M1: Context Daemon + 最小快照

### 新增文件

| 文件 | 说明 |
|------|------|
| `Models/ContextSnapshot.swift` | 快照数据模型 (Codable + Sendable)，含 `toPromptYAML()` 和 `toDebugJSON()` |
| `Services/ContextDaemon.swift` | 采集调度器，10s 轮询，管理 4 个 Monitor |
| `Services/Monitors/ForegroundAppMonitor.swift` | NSWorkspace 事件驱动，追踪前台 app |
| `Services/Monitors/WindowTitleMonitor.swift` | AX API 读窗口标题，需 Accessibility 权限 |
| `Services/Monitors/IdleTimeMonitor.swift` | CGEventSource 空闲检测 |
| `Services/Monitors/RecentFilesMonitor.swift` | NSMetadataQuery (Spotlight) 最近文件 |
| `Services/PermissionManager.swift` | 权限检测 + 系统设置深链接 |
| `Views/Settings/PermissionGuideView.swift` | 权限引导卡片 UI |

### 修改文件

| 文件 | 改动 |
|------|------|
| `MantleApp.swift` | 启动 ContextDaemon；Dock click 重开窗口；AppDelegate 添加 `applicationShouldHandleReopen` |
| `ViewModels/AppViewModel.swift` | 持有 contextDaemon + permissionManager |
| `Views/Settings/SettingsView.swift` | 新增 Context tab（快照预览 + 权限状态） |
| `Views/MenuBar/PopoverView.swift` | 添加 Settings 齿轮按钮 |
| `Services/NotificationManager.swift` | 添加 Bundle ID 空值保护 |
| `Info.plist` | 添加 `NSAllowsLocalNetworking` (ATS) |

### 快照字段

```yaml
# Current environment
foreground: Xcode — AppViewModel.swift
recent: file1.swift, file2.swift
activity: active, idle 3s | focus: 12 min
```

## M2: 快照注入 agent-core

### agent-core 改动 (TypeScript)

| 文件 | 改动 |
|------|------|
| `src/http.ts` | `RunRequestBody` 新增 `context?: string`，`/runs` 和 `/runs/stream` 解析并透传 |
| `src/service.ts` | `RunOnceOptions`/`StreamRunOptions` 新增 `context`，`buildInputMessages()` 将 context 作为 system message 注入 |

### Mantle 改动 (Swift)

| 文件 | 改动 |
|------|------|
| `Services/SSEStreamClient.swift` | `RunStreamRequest` 新增 `context: String?` |
| `ViewModels/ChatViewModel.swift` | `send()` 接受 context 参数 |
| `ViewModels/AppViewModel.swift` | `send()`、`retry`、`editAndResend`、`regenerateResponse` 均注入 `contextDaemon.currentSnapshot.toPromptYAML()` |

### 数据流

```
用户发送 → AppViewModel.send()
  → 捕获 contextDaemon.currentSnapshot.toPromptYAML()
  → ChatViewModel.send(text, threadId, context)
  → SSEStreamClient POST /runs/stream { threadId, input, context }
  → agent-core buildInputMessages()
  → [{ role: "system", content: contextYAML }, { role: "user", content: input }]
  → LLM
```

## 踩坑记录

1. **Package.swift 与 .xcodeproj 冲突**: Package.swift 定义了 `executableTarget`，Xcode 优先使用它构建裸二进制（无 .app bundle），导致 Bundle ID 为 nil、Accessibility 无法授权、NotificationManager 崩溃。解决：移除 Package.swift，创建 shared xcscheme。

2. **Accessibility 权限绑定路径**: macOS 用二进制路径+哈希识别程序。无代码签名时每次编译哈希变化导致权限失效。开启 Automatic Signing 后权限可跨编译保持。

3. **ATS 阻止本地 HTTP**: 开启签名后 App Transport Security 生效，阻止 `http://127.0.0.1:8787`。添加 `NSAllowsLocalNetworking` 解决。

4. **`kAXTrustedCheckOptionPrompt` 严格并发**: Swift 6 strict concurrency 不允许直接使用该全局常量。用硬编码字符串 `"AXTrustedCheckOptionPrompt"` 绕过。

5. **DerivedData 多目录**: Xcode 可能为同一项目创建多个 DerivedData 目录，需要确保只保留正确的那个。

## 下一步 (M3)

- 场景 B 桌面整理（护栏 + fs tools）
- 验证 context 注入对 LLM 回答质量的实际影响
