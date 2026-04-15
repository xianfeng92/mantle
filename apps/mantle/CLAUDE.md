# Mantle — Claude 指令

## 项目定位

Mantle 是一个 **Desktop-First AI Agent**：原生 macOS 应用，作为 agent-core 的桌面前端。

核心定位与 OpenClaw 等 Chat-First agent 的区别：
- **输入方式**：文字 + 语音 + 全局热键 + 划选 + Shortcuts + Siri + AppleScript
- **环境感知**：活跃 App + 窗口标题 + 选中文本 + 最近文件 + 空闲状态 + Focus Mode
- **执行能力**：Shell + API + 桌面控制（点击/输入/截图/UI 树）
- **集成深度**：OS 级别（Services, Shortcuts, Spotlight, URL Scheme, AppleScript）

### 功能决策原则

每个新功能先问：**这个功能是否利用了桌面原生能力？**
- 如果是 → 高优先级
- 如果纯文字聊天也能做 → 优先级降低，考虑在飞书 Channel 上实现

## 技术栈

- 语言：Swift 6 / SwiftUI
- 最低部署目标：macOS 14.0 (Sonoma)
- 数据持久化：SwiftData
- 后端通信：HTTP/SSE → agent-core (localhost:8787)
- Computer Use：本地 HTTP Server (localhost:19816) 接收 agent-core 调用

## 项目结构

```
Mantle/
├── CLAUDE.md
├── Info.plist
├── MantleApp.swift          # 入口：Window + MenuBar + URL Scheme + Spotlight
├── Intents/                  # App Intents (Shortcuts / Siri)
│   ├── AskMantleIntent.swift
│   ├── StartWorkflowIntent.swift
│   └── MantleShortcuts.swift
├── Models/
│   ├── ContextSnapshot.swift # 环境快照（含 Focus Mode）
│   ├── PersistentModels.swift
│   └── AgentCoreTypes.swift
├── Services/
│   ├── AgentCoreClient.swift      # HTTP 客户端
│   ├── BackendProcessManager.swift # Node.js 进程管理
│   ├── ComputerUseService.swift    # 桌面控制（AX + CG）
│   ├── ComputerUseServer.swift     # HTTP bridge (19816)
│   ├── ContextDaemon.swift         # 环境感知（含 Focus Mode 检测）
│   ├── GlobalHotkeyService.swift   # ⌥Space
│   ├── KeychainService.swift       # 安全凭证存储
│   ├── SpotlightService.swift      # 会话 Spotlight 索引
│   ├── SpeechService.swift         # VAD + ASR + TTS
│   └── TextSelectionService.swift  # System Services
├── ViewModels/
│   └── AppViewModel.swift
└── Views/
    ├── Chat/
    ├── MainWindow/
    ├── MenuBar/
    ├── Settings/
    ├── HITL/
    └── Shared/
```

## OS 集成清单

| 集成 | 状态 | 入口文件 |
|------|------|----------|
| 全局热键 ⌥Space | ✅ | GlobalHotkeyService.swift |
| System Services "Ask Mantle" | ✅ | TextSelectionService.swift |
| Menu Bar Extra | ✅ | MantleApp.swift |
| Context Daemon | ✅ | ContextDaemon.swift |
| 语音 VAD+ASR | ✅ | SpeechService.swift |
| Computer-Use | ✅ | ComputerUseService.swift |
| Launch at Login | ✅ | LaunchAtLoginManager.swift |
| 通知 | ✅ | NotificationManager.swift |
| URL Scheme `mantle://` | ✅ | MantleApp.swift |
| App Intents / Shortcuts | ✅ | Intents/ |
| Spotlight 索引 | ✅ | SpotlightService.swift |
| Focus Mode 感知 | ✅ | ContextDaemon.swift |
| Keychain 存储 | ✅ | KeychainService.swift |

## 协作规则

- 新 spec → `docs/specs/`
- 实现说明 → `docs/changes/`
- review → `docs/reviews/`
- 不要把设计决策只留在对话里

## 运行与验证

```bash
cd /Users/xforg/AI_SPACE/Mantle
# Xcode 打开
open Mantle.xcodeproj
# 或命令行构建
xcodebuild -scheme Mantle -configuration Debug build
```

## 注意事项

- Accessibility 和 Screen Recording 权限需要用户手动在 System Settings 中授权
- Computer Use Server 默认端口 19816，不要与其他服务冲突
- URL Scheme 路由在 `MantleApp.handleDeepLink()` 中处理
- App Intents 需要 macOS 14+ 才能使用
