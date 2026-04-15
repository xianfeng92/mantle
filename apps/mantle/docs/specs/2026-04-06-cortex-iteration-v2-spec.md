---
title: "Mantle 迭代优化 V2 — 持久化 / Markdown / 后端自管理 / 输入状态"
status: implemented
owner: claude
created: 2026-04-06
updated: 2026-04-06
implements:
  - docs/changes/2026-04-06-mantle-iteration-v2-impl-notes.md
reviews:
  - docs/reviews/2026-04-06-mantle-iteration-v2-review.md
---

# Mantle 迭代优化 V2

基于深度体验评估报告，本轮迭代聚焦 4 项核心需求，目标：将 Mantle 从"可运行的 demo"提升为"可日用的工具"。

## 1. 需求总览

| # | 需求 | 优先级 | 新增文件 | 修改文件 | 预估代码行 |
|---|------|--------|---------|---------|-----------|
| 1 | 消息持久化（SwiftData） | P0 | 1 | 3 | ~300 |
| 2 | Markdown 渲染 + 代码高亮 | P0 | 2 | 1 | ~400 |
| 3 | 后端自管理（Node.js 进程） | P0 | 1 | 3 | ~250 |
| 4 | 输入框状态感知 | P1 | 0 | 3 | ~80 |

实现顺序：Step 1 消息持久化（地基）→ Step 2 Markdown + 输入框（可并行）→ Step 3 后端自管理（独立）。

## 2. 消息持久化（SwiftData）

### 2.1 数据模型

三层 SwiftData `@Model`，cascade 关系：

```
PersistedThread (1) ──cascade──→ (N) PersistedMessage (1) ──cascade──→ (N) PersistedToolEvent
```

**PersistedThread**

| 字段 | 类型 | 说明 |
|------|------|------|
| id | String | UUID, unique |
| title | String | 显示标题 |
| createdAt | Date | 创建时间 |
| updatedAt | Date | 最后活跃 |
| lastTraceId | String? | 调试用 |
| errorMessage | String? | 最后错误 |
| messages | [PersistedMessage] | @Relationship(.cascade) |

**PersistedMessage**

| 字段 | 类型 | 说明 |
|------|------|------|
| id | String | UUID, unique |
| role | String | "user" / "assistant" / "system" / "tool" |
| text | String | 消息内容 |
| timestamp | Date | 发送时间 |
| sortOrder | Int | 保证消息顺序（SwiftData @Relationship 不保证数组序） |
| thread | PersistedThread | 反向引用 |
| toolEvents | [PersistedToolEvent] | @Relationship(.cascade) |

**PersistedToolEvent**

| 字段 | 类型 | 说明 |
|------|------|------|
| id | String | UUID, unique |
| toolName | String | 工具名 |
| statusRaw | String | "running" / "completed" / "failed" |
| input | String? | JSON String（原 AnyCodable） |
| output | String? | JSON String |
| error | String? | 错误信息 |
| timestamp | Date | 调用时间 |
| sortOrder | Int | 保证顺序 |
| message | PersistedMessage | 反向引用 |

### 2.2 双层模型策略

- **持久层**：`PersistedThread` / `PersistedMessage` / `PersistedToolEvent` — SwiftData `@Model` class，字段全部用基础类型（String, Date, Int）
- **视图层**：现有 `ThreadState` / `ChatMessage` / `ToolEvent` struct 保留，继续作为 View 的数据源
- **转换方法**：
  - `ThreadState.init(from: PersistedThread)` — 从持久层读取
  - `ThreadState.save(to: ModelContext)` — 写回持久层

保留双层的原因：SwiftData `@Model` 是引用类型（class），直接用在 SwiftUI View 中会导致值语义丢失和 diff 失效。现有 struct 保持 View 的正确行为。

### 2.3 瞬态字段

以下字段**不持久化**，重启后自然重置：

- `ThreadState.isStreaming` → `false`
- `ThreadState.pendingApproval` → `nil`
- `ThreadState.error` → `nil`（errorMessage 持久化最后一次错误，但 UI 层的实时错误不持久化）

### 2.4 持久化时机

| 事件 | 写入策略 |
|------|---------|
| 用户发送消息 | 立即写入 user message |
| 流式 text_delta | 不写（频率太高） |
| 流结束 run_completed / run_interrupted | 写入完整 assistant message + tool events |
| 创建 / 删除线程 | 立即写入 / 删除 |
| HITL 审批状态 | 不持久化（瞬态） |

### 2.5 ModelContainer 注入

在 `MantleApp` 中手动创建 `ModelContainer`，将其 `mainContext` 通过初始化参数注入 `AppViewModel`：

```swift
// MantleApp.swift
@main struct MantleApp: App {
    let container: ModelContainer
    @State private var appVM: AppViewModel

    init() {
        let container = try! ModelContainer(for: PersistedThread.self)
        self.container = container
        self._appVM = State(initialValue: AppViewModel(modelContext: container.mainContext))
    }

    var body: some Scene {
        WindowGroup("Mantle", id: "main") { ... }
            .modelContainer(container)
        // ...
    }
}
```

注意：`@Environment(\.modelContext)` 只在 SwiftUI View 中可用，不能在 `@Observable` 类中使用。因此 `AppViewModel` 通过构造函数接收 `ModelContext`。

### 2.6 迁移

UserDefaults 中旧的 `mantle.threads` 数据在首次启动时迁移到 SwiftData，迁移完成后清除旧数据。由于旧数据只有 id + title（无消息），迁移逻辑很简单。

错误处理：如果迁移失败（UserDefaults 数据格式异常），记录日志但不阻塞启动——空白状态优于启动崩溃。

### 2.7 文件清单

- **新增** `Mantle/Models/PersistentModels.swift` — 三个 @Model 定义 + 转换方法
- **修改** `Mantle/Models/ThreadState.swift` — 新增 `init(from:)` 和 `save(to:)`
- **修改** `Mantle/ViewModels/AppViewModel.swift` — SwiftData 查询替代内存数组 + UserDefaults
- **修改** `Mantle/MantleApp.swift` — `.modelContainer` 注入

## 3. Markdown 渲染 + 代码高亮

### 3.1 渲染管线

```
原始 Markdown 文本
  ↓ swift-markdown 解析
Document (AST)
  ↓ MarkdownRenderer (MarkupWalker)
[RenderSegment]  — text(AttributedString) | codeBlock(lang, code) | blockquote(AttributedString)
  ↓ MarkdownContentView (SwiftUI)
Text(attributed) + CodeBlockView + BlockquoteView 交替排列
```

### 3.2 节点映射

| Markdown 节点 | 渲染效果 | AttributedString 属性 |
|--------------|---------|---------------------|
| `# Heading 1-4` | 大号粗体，逐级缩小 | `.font: .title / .title2 / .title3 / .headline` |
| `**bold**` | 粗体 | `.font: .body.bold()` |
| `*italic*` | 斜体 | `.font: .body.italic()` |
| `` `inline code` `` | 等宽 + 背景色 | `.font: .monospaced + .backgroundColor` |
| `- list item` | 缩进列表 | 前缀 "• " / "1. " + 缩进 |
| `> blockquote` | 左边框 + 灰色文字 | `.foregroundColor: .secondary`（View 层加左边框） |
| `[link](url)` | 蓝色可点击 | `.link: URL + .foregroundColor: .blue` |
| `\| table \|` | 等宽对齐文本 | 等宽字体 + 制表符对齐（CJK 安全：用 `Grid` 布局而非空格）|
| ` ```code``` ` | 独立 CodeBlockView | 不在 AttributedString 中 |

### 3.3 CodeBlockView

视觉设计：
- 深色背景（`#1e1e2e`）圆角容器
- 顶部栏：语言标签（左）+ Copy 按钮（右）
- 代码区：等宽字体 + 语法高亮
- Copy 按钮点击后显示 ✓ 反馈 1.5s

语法高亮方案（轻量正则）：
- 关键词 — 按语言预置关键词表（紫色）
- 字符串 — 匹配 `"..."` / `'...'` / `` `...` ``（绿色）
- 注释 — `//` 和 `/* */`（灰色）
- 数字 — 整数 / 浮点（橙色）
- 函数调用 — `identifier(`（蓝色）
- 类型 — 首字母大写标识符（黄色）

支持语言：Swift, Python, JavaScript, TypeScript, Shell, JSON, YAML, HTML, CSS, Go, Rust。未识别语言 fallback 为无高亮等宽文本。

### 3.4 流式渲染性能

- **节流渲染**：流式输出中每 `streamingThrottleInterval`（默认 300ms，可配置常量）触发一次 Markdown 解析，中间用纯 `Text` 显示原始文本。流结束后做一次完整渲染。
- **后台解析**：`MarkdownRenderer.render()` 在 nonisolated context 执行，结果可缓存。
- **异步高亮**：CodeBlockView 在 `.task {}` 中异步执行语法高亮，先显示无高亮文本，完成后替换。

### 3.5 MessageBubble 集成

现有 `Text(message.text)` 替换为 `MarkdownContentView(text: message.text)`。`MarkdownContentView` 按 segments 顺序用 `ForEach` + `switch` 渲染 Text / CodeBlockView / BlockquoteView。

### 3.6 文件清单

- **新增** `Mantle/Views/Chat/MarkdownRenderer.swift` — AST → segments 转换器（~200 行）
- **新增** `Mantle/Views/Chat/CodeBlockView.swift` — 代码块组件 + 语法高亮 + 复制按钮（~150 行）
- **修改** `Mantle/Views/Chat/MessageBubble.swift` — Text → MarkdownContentView

## 4. 后端自管理（BackendProcessManager）

### 4.1 状态机

```
app 启动 → detecting → starting → running
                                     ↓ (进程退出)
                                  restarting → running (重试 ≤ 3 次)
                                     ↓ (超过 3 次)
                                  crashed (显示错误 + 手动重试按钮)

detecting 找不到 node → nodeNotFound (弹窗引导)
starting 健康检查超时 → startFailed (显示错误)

app 退出 → SIGTERM → 等待 2s → SIGKILL
```

### 4.2 Node 路径检测

按优先级搜索：

1. 用户手动配置（Settings 中指定，UserDefaults 持久化）
2. `/opt/homebrew/bin/node` — Apple Silicon Homebrew
3. `/usr/local/bin/node` — Intel Mac Homebrew / 官方安装器
4. `~/.nvm/versions/node/*/bin/node` — nvm（取最新版本）
5. `~/.volta/tools/image/node/*/bin/node` — Volta
6. `/usr/bin/env node` — 系统 PATH fallback

检测到后执行 `node --version`，要求 ≥ v18.0.0。

### 4.3 启动流程

1. 检测 node 路径
2. 确定 agent-core 目录（Settings 配置 > `~/AI_SPACE/agent-core` 默认值）
3. 对 `http://127.0.0.1:8787/health` 发送健康检查 → 如已返回 `ok: true`，直接标记 `running`（兼容手动启动）
4. 创建 `Process()`，设置 `executableURL`、`arguments: ["dist/src/serve.js"]`、`currentDirectoryURL`、`environment`
5. 捕获 stdout/stderr 到 Pipe（用于日志）
6. 设置 `terminationHandler` 处理崩溃重启
7. 轮询健康检查（最多 15s），成功则标记 `running`

### 4.4 崩溃重启策略

- 进程非正常退出（exitCode ≠ 0）时自动重启
- 最多重试 3 次，每次间隔 2s
- 超过 3 次标记为 `crashed`，UI 显示错误 + 手动"Retry"按钮
- 正常退出（exitCode == 0 或用户主动 stop）不重启

### 4.5 与 AppViewModel 集成

- `BackendProcessManager` 是独立 actor，只负责进程生命周期
- 状态变更通过 `AsyncStream<ProcessState>` 通知外部：

```swift
// BackendProcessManager
actor BackendProcessManager {
    private let (stateStream, stateContinuation) = AsyncStream.makeStream(of: ProcessState.self)
    var stateUpdates: AsyncStream<ProcessState> { stateStream }

    private var _state: ProcessState = .detecting {
        didSet { stateContinuation.yield(_state) }
    }
}

// AppViewModel 消费
func observeProcessManager() {
    Task {
        for await state in processManager.stateUpdates {
            self.backendStatus = mapProcessState(state)
        }
    }
}
```

- `AppViewModel` 在 `init()` 中创建 ProcessManager 实例并开始监听 `stateUpdates`
- 启动时调用 `processManager.start()`
- 现有健康检查逻辑保留作为双保险（ProcessManager 标记 running 后，健康检查确认 API 可用）
- app 退出时调用 `processManager.stop()`

### 4.6 Settings 集成

Connection Tab 新增：

| 设置项 | 类型 | 默认值 |
|--------|------|--------|
| Auto-start backend | Toggle | ON |
| Node.js path | 文件选择器 + 文本框 | (auto-detect) |
| agent-core path | 文件夹选择器 + 文本框 | ~/AI_SPACE/agent-core |
| Backend status | 状态标签 + Restart 按钮 | — |

### 4.7 文件清单

- **新增** `Mantle/Services/BackendProcessManager.swift` — 进程管理 actor（~200 行）
- **修改** `Mantle/ViewModels/AppViewModel.swift` — 集成 ProcessManager
- **修改** `Mantle/Views/Settings/SettingsView.swift` — node/agent-core 路径配置
- **修改** `Mantle/MantleApp.swift` — app 退出时 terminate 进程

## 5. 输入框状态感知

### 5.1 三种状态

| 状态 | 条件 | 输入框 | 按钮 | Placeholder |
|------|------|--------|------|-------------|
| 正常 | isConnected && !isStreaming | 可输入 | 紫色 ↑（有文字时）/ 灰色（空文字） | "Ask Mantle..." |
| 流式中 | isStreaming | 禁用输入 | 红色 ■ Stop | "Mantle is thinking..." |
| 断开 | !isConnected | 禁用输入 | 灰色 ↑ 禁用 | "⚠ Backend not connected" |

### 5.2 ChatInputBar 接口变更

新增三个参数：

```swift
struct ChatInputBar: View {
    var onSend: (String) -> Void
    var isConnected: Bool      // 新增
    var isStreaming: Bool       // 新增
    var onStop: (() -> Void)?  // 新增
}
```

内部派生：
- `inputDisabled = !isConnected || isStreaming`
- `buttonMode: .send | .stop | .disabled`

### 5.3 AppViewModel 停止方法

新增 `stopActiveStream()` 方法，完成从 UI 到 ChatViewModel 的完整调用链：

```swift
// AppViewModel
func stopActiveStream() {
    chatVM.cancel()
    if let id = activeThreadId,
       let index = threads.firstIndex(where: { $0.id == id }) {
        threads[index].isStreaming = false
    }
}
```

调用链：`ChatInputBar.onStop` → `appVM.stopActiveStream()` → `chatVM.cancel()`

### 5.4 按钮切换

发送（↑）与停止（■）使用 `.contentTransition(.symbolEffect(.replace))` 平滑过渡。

### 5.5 键盘交互

| 按键 | 正常 | 流式中 | 断开 |
|------|------|--------|------|
| Enter | 发送 | 无操作 | 无操作 |
| Shift+Enter | 换行 | 无操作 | 无操作 |
| Esc | 清空输入框 | 停止生成 | 无操作 |

### 5.6 文件清单

- **修改** `Mantle/Views/Chat/ChatInputBar.swift` — 三态逻辑 + 按钮切换（~40 行变更）
- **修改** `Mantle/Views/MainWindow/ChatDetailView.swift` — 传入 isConnected / isStreaming / onStop
- **修改** `Mantle/Views/MenuBar/PopoverView.swift` — 同上

## 6. 实现顺序

```
Step 1: 消息持久化 ──→ Step 2a: Markdown 渲染 ──→ Step 3: 后端自管理
                   ╲                           ╱
                    ──→ Step 2b: 输入框状态 ───╱
```

Step 2a 和 2b 可并行。Step 3 与前两步无代码依赖，可在任意时机执行。

## 7. 不在本轮范围内

- 全局热键 ⌘⇧Space
- HITL 单项控制 / Edit
- 系统通知
- 选中文字 / 文件拖拽
- 消息操作（复制 / 重试 / 时间戳）
