# Mantle Workspace Mode + Starter Flows 实施记录

**日期**: 2026-04-12
**作者**: Codex
**对应方向**: Mantle 原生端作为 Gemma 4 主入口的工作流收敛

## 背景

- 之前 `Mantle` 原生端会在启动 `agent-core` 时把工作区硬编码到用户 `Home`，并默认关闭 `virtualMode`
- `agent-core /health` 已经能返回 `model / promptProfile / contextWindowSize / workspaceDir / workspaceMode / virtualMode`
- 交互入口主要还是空白输入框，对 Gemma 4 这种更适合“聚焦入口 + 短回路”的模型不够友好

## 本次改动

### 1. 原生启动配置支持 workspace mode

新增 `WorkspaceMode`：

- `repo`
- `workspace`
- `custom`

改动文件：

| 文件 | 说明 |
|------|------|
| `Mantle/Mantle/Services/BackendProcessManager.swift` | 新增 `WorkspaceMode`、扩展 `Config`、根据模式解析 `AGENT_CORE_WORKSPACE_DIR` |
| `Mantle/Mantle/Views/Settings/SettingsView.swift` | 设置页增加 workspace mode、custom path、virtual mode 开关 |

行为：

- `repo`：工作区 = `agent-core` 目录
- `workspace`：工作区 = `agent-core` 的父目录（例如 `AI_SPACE`）
- `custom`：工作区 = 用户选择的任意目录
- `virtualMode` 现在也由原生设置控制，并保存到 `UserDefaults`

### 2. 原生端展示 backend 运行态

改动文件：

| 文件 | 说明 |
|------|------|
| `Mantle/Mantle/Models/AgentCoreTypes.swift` | `HealthResponse` 补充 context/workspace/virtualMode 字段 |
| `Mantle/Mantle/ViewModels/AppViewModel.swift` | 新增 `backendHealth`，健康检查成功后缓存完整 health 数据 |
| `Mantle/Mantle/Views/MainWindow/MainWindowView.swift` | 顶部 toolbar 显示 model、prompt profile、context、workspace mode |
| `Mantle/Mantle/Views/Settings/SettingsView.swift` | 设置页显示 prompt profile、context window、effective workspace |

这样在原生端就能直接看到当前运行态，而不是只知道“连上了后端”。

### 3. 原生 starter flows

改动文件：

| 文件 | 说明 |
|------|------|
| `Mantle/Mantle/ViewModels/AppViewModel.swift` | 新增 `StarterFlow` 和 `starterFlows`，统一管理四类入口 prompt |
| `Mantle/Mantle/Views/MainWindow/MainWindowView.swift` | 无选中线程时展示原生 starter cards |
| `Mantle/Mantle/Views/MainWindow/ThreadSidebar.swift` | 侧边栏底部新增 `Quick Start` 区域 |
| `Mantle/Mantle/Views/MainWindow/ChatDetailView.swift` | 空线程时展示 starter grid 和运行态 badge |
| `Mantle/Mantle/Views/MenuBar/PopoverView.swift` | 浮窗标题栏显示运行态，并在无会话/空会话时展示 starter flows |

当前四类入口：

- `Coding`
- `Docs`
- `Diagnostics`
- `Desktop-lite`

设计目标不是替代输入框，而是让 Gemma 4 在原生端也能从“明确场景”进入，而不是每次从零猜任务模式。

### 4. Popover 与主窗口保持一致

- `PopoverView` 标题栏现在会展示 `model / prompt profile / context / workspace mode`
- 浮窗在两种状态下都能直接启动 starter flows：
  - 没有活动线程
  - 已有活动线程，但还是空线程
- 浮窗继续保留轻量输入栏，不强迫用户切到全窗口才能开始任务

### 5. ChatInputBar 任务模式切换

新增线程级任务模式：

- `auto`
- `coding`
- `docs`
- `desktop-lite`

改动文件：

| 文件 | 说明 |
|------|------|
| `Mantle/Mantle/Models/ThreadState.swift` | 新增 `ThreadTaskMode`，线程保存当前任务模式 |
| `Mantle/Mantle/Models/PersistentModels.swift` | `PersistedThread` 持久化 `taskModeRaw` |
| `Mantle/Mantle/ViewModels/AppViewModel.swift` | 新增 `composerTaskMode`，发送时把任务模式注入上下文 |
| `Mantle/Mantle/Views/Chat/ChatInputBar.swift` | 输入栏新增任务模式切换与 mode-specific placeholder |

效果：

- 输入栏切换不只是 UI 状态，会影响后续发送给 `agent-core` 的上下文
- 切换线程时，会恢复该线程自己的任务模式
- starter flow 也会同步设置线程标题和任务模式，避免“入口”和“输入栏”状态不一致

### 6. 浮窗常驻诊断状态条

改动文件：

| 文件 | 说明 |
|------|------|
| `Mantle/Mantle/Models/AgentCoreTypes.swift` | 补齐 `contextUsage / compaction / verification / staging` 结构 |
| `Mantle/Mantle/ViewModels/AppViewModel.swift` | 健康检查成功后顺带刷新 diagnostics，并缓存到 `backendDiagnostics` |
| `Mantle/Mantle/Views/MenuBar/PopoverView.swift` | 在标题区下方显示压缩诊断状态条 |

当前浮窗状态条展示：

- `Ctx <percent>`
- `Verify <percent>`
- `Compact <count>`
- `Fallback <count>`

目标是让用户在浮窗里就能判断 Gemma 当前是“上下文压力过高”、 “验证在失败”，还是“工具调用正在退化”，而不是必须进设置页看完整 diagnostics。

### 7. 浮窗运行态信息去重

在实际使用里，浮窗标题下方原本同时存在：

- 一行摘要：`model · prompt profile · context`
- 一行 badge：再次显示 `model / prompt profile / context / workspace mode`

这会导致 `Gemma 4 26B`、`compact`、`28.0K` 这类信息在同一区域重复出现。

本次收口后：

- 删除标题下方的摘要行
- 保留 badge 行作为唯一的运行态主展示
- 原本挂在摘要行上的 hover 说明，迁移到 badge 区域，避免丢失 `workspace / virtual mode` 这类辅助信息

### 8. 主窗口 toolbar 运行态改为紧凑标签

主窗口顶部 toolbar 原本直接展示原始 model identifier，例如：

- `google/gemma-4-26b-a4b · compact · 28.0K · workspace`

这在同时存在搜索框时很容易被截断，看起来像“显示不全”。

本次改为：

- toolbar 主显示使用更短的 label，例如 `Gemma 4 26B · compact · 28K · ws`
- 完整原始值放到 hover 说明中
- `context` 也改成更紧凑的 `28K` 形式，减少无意义的小数位
- `workspace mode` 不再混在摘要串里，而是改成单独的图标 badge
  - `Workspace`：网格图标
  - `Repo`：文件夹图标
  - `Custom`：带齿轮的文件夹图标

### 9. 语音能力按主路径 / 可选 / 实验分层

这次没有删除语音模块，而是按产品优先级重新收口：

- `ASR` 保留为主路径能力
  - 麦克风按钮继续保留
  - 单次语音输入仍然可以直接转文本并发送
- `TTS` 保留，但明确变成可选能力
  - 设置页新增 `Auto-speak assistant replies`
  - 默认仍以文本工作流为主，不要求用户进入语音模式
- `VAD` 继续用于辅助单次语音输入自动停录
  - 但不再把它包装成默认主交互
- `完整语音闭环` 降为实验功能
  - 设置页新增 `Enable experimental voice conversation`
  - 默认关闭
  - 输入栏只有在显式开启后才显示 conversation mode 按钮

对应改动文件：

| 文件 | 说明 |
|------|------|
| `Mantle/Mantle/Services/SpeechService.swift` | 新增实验语音闭环开关、TTS 路由摘要、禁用时自动退出 conversation mode |
| `Mantle/Mantle/Views/Chat/ChatInputBar.swift` | conversation mode 控件默认隐藏，仅在实验开关开启后显示；单次语音输入状态文案更明确 |
| `Mantle/Mantle/Views/Settings/SettingsView.swift` | 新增语音设置区，区分 `ASR`、`TTS` 和实验语音闭环 |

### 10. TTS 改成两档显式策略

为了降低“语音能说话，但到底会走哪条链路”这种不透明感，`TTS` 不再默认走隐式的长 fallback 链，而是改成两档明确策略：

- `Local First`
  - 优先 `Piper`
  - 不可用时回退到 `Apple say`
- `System First`
  - 优先 `Apple say`
  - 失败时再回退到 `Piper`

这次没有把 `Edge TTS` 彻底删掉，但它已经不再属于默认运行路径，只保留为 legacy helper。

对应改动文件：

| 文件 | 说明 |
|------|------|
| `Mantle/Mantle/Services/SpeechService.swift` | 新增 `TTSStrategy`，把运行时路由收成 `Local First / System First` 两档 |
| `Mantle/Mantle/Views/Settings/SettingsView.swift` | 设置页新增 `TTS Strategy` 分段选择 |

## 验证

已执行：

```bash
xcodebuild -project /Users/xforg/AI_SPACE/Mantle/Mantle.xcodeproj \
  -scheme Mantle \
  -configuration Debug \
  -derivedDataPath /tmp/MantleDerived \
  build
```

结果：

- `BUILD SUCCEEDED`

## 影响与后续

- 这次没有删除 `agent-core/web`，避免误删仍可能用于诊断的界面
- 这次也没有改 `PopoverView` 的入口体验，主改动先集中在 `MainWindow`

下一步建议：

1. 把相同的 starter flows 同步到 `PopoverView`
2. 给 `Desktop-lite` 增加更显式的步数预算和 verify 状态显示
3. 继续把任务模式和 `agent-core` 的 tool staging 做更强绑定
