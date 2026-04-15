---
title: "Mantle V2 实现计划"
status: implemented
owner: claude
created: 2026-04-06
updated: 2026-04-06
implements:
  - docs/specs/2026-04-06-mantle-iteration-v2-spec.md
reviews: []
---

# Mantle V2 — 详细实现计划

## 实现顺序

```
Step 1: SwiftData 持久化 ─────────→ Step 2a: Markdown 渲染 ──→ Step 3: 后端自管理
                         ╲                                  ╱
                          ─→ Step 2b: 输入框状态 ──────────╱
```

Step 2a 和 2b 可并行。Step 3 在最后，因为它与 Step 1 共同修改 AppViewModel 和 MantleApp。

## 文件变更总表

| 文件 | Step | 动作 | 变更内容 |
|------|------|------|---------|
| `Models/PersistentModels.swift` | 1 | 新增 | 3 个 @Model class + cascade 关系 |
| `Models/ThreadState.swift` | 1 | 修改 | 新增 init(from:) 和 save(to:) |
| `ViewModels/AppViewModel.swift` | 1,2b,3 | 修改 | ModelContext、持久化调用、迁移、stopActiveStream、processManager |
| `MantleApp.swift` | 1,3 | 修改 | ModelContainer 注入、shutdown hook |
| `Views/Chat/MarkdownRenderer.swift` | 2a | 新增 | MarkupWalker + RenderSegment + MarkdownContentView |
| `Views/Chat/CodeBlockView.swift` | 2a | 新增 | 代码块 UI + SyntaxHighlighter |
| `Views/Chat/MessageBubble.swift` | 2a | 修改 | Text → MarkdownContentView |
| `Views/Chat/ChatInputBar.swift` | 2b | 修改 | 三态逻辑、Stop 按钮、Esc 键 |
| `Views/MainWindow/ChatDetailView.swift` | 2b | 修改 | 传入 isConnected/isStreaming/onStop |
| `Views/MenuBar/PopoverView.swift` | 2b | 修改 | 传入 isConnected/isStreaming/onStop |
| `Services/BackendProcessManager.swift` | 3 | 新增 | 进程生命周期 actor |
| `Views/Settings/SettingsView.swift` | 3 | 修改 | node/agent-core 路径配置 + 状态 UI |

**合计**: 4 个新增文件，8 个修改文件。

---

## Step 1: SwiftData 消息持久化

### 1.1 新增 `Models/PersistentModels.swift`

三个 `@Model` class，cascade 关系：

- `PersistedThread`: id(unique), title, createdAt, updatedAt, lastTraceId?, errorMessage?, messages(@Relationship .cascade)
- `PersistedMessage`: id(unique), role(String), text, timestamp, sortOrder(Int), thread(inverse), toolEvents(@Relationship .cascade)
- `PersistedToolEvent`: id(unique), toolName, statusRaw(String), input?(JSON String), output?, error?, timestamp, sortOrder(Int), message(inverse)

所有字段用基础类型，不用 enum/自定义类型。sortOrder 保证数组顺序。

### 1.2 修改 `Models/ThreadState.swift`

新增两个转换方法：
- `ThreadState.init(from: PersistedThread)` — 读取持久层，按 sortOrder 排序 messages 和 toolEvents，瞬态字段默认值
- `ThreadState.save(to: ModelContext)` — upsert：按 id 查找或新建，diff messages/toolEvents，更新 text 和 sortOrder

### 1.3 修改 `ViewModels/AppViewModel.swift`

- `init()` → `init(modelContext: ModelContext)`
- `loadThreads()` → FetchDescriptor 查询 PersistedThread，按 updatedAt 降序
- 删除 `saveThreadOrder()`，新增 `persistThread(at:)` 调用 save(to:) + context.save()
- 迁移逻辑：读 UserDefaults 旧数据 → 创建 PersistedThread → 删除旧数据（失败则跳过）
- `send()` 中用户消息立即持久化
- `applyStreamUpdate` 中 .completed/.error 时持久化
- .textDelta 不持久化

### 1.4 修改 `MantleApp.swift`

```swift
init() {
    let container = try! ModelContainer(for: PersistedThread.self, PersistedMessage.self, PersistedToolEvent.self)
    self.container = container
    self._appVM = State(initialValue: AppViewModel(modelContext: container.mainContext))
}
```

### 1.5 测试检查点

- App 正常启动（ModelContainer 创建成功）
- 新建线程 → 退出重启 → 线程仍在
- 发消息收回复 → 退出重启 → 消息可见
- 删除线程 → 数据库同步删除
- 旧 UserDefaults 数据迁移
- 瞬态字段重启后重置

---

## Step 2a: Markdown 渲染 + 代码高亮

### 2a.1 新增 `Views/Chat/MarkdownRenderer.swift`

- `RenderSegment` enum: .text(AttributedString) / .codeBlock(lang, code) / .blockquote(AttributedString)
- `MarkdownRenderer` 实现 `MarkupWalker`，遍历 AST 节点生成 segments
- `MarkdownContentView`: 接收 text，解析为 segments，ForEach 渲染 Text/CodeBlockView/BlockquoteView
- 流式节流：isStreaming 时每 300ms 重解析一次，流结束后完整渲染

### 2a.2 新增 `Views/Chat/CodeBlockView.swift`

- 深色背景容器 + 语言标签 + Copy 按钮（点击后 ✓ 反馈 1.5s）
- `SyntaxHighlighter`: 轻量正则，支持 Swift/Python/JS/TS/Shell/JSON/YAML/HTML/CSS/Go/Rust
- 高亮在 `.task {}` 中异步执行，先显示无高亮文本

### 2a.3 修改 `Views/Chat/MessageBubble.swift`

```swift
// 前: Text(message.text)
// 后: MarkdownContentView(text: message.text)
```

### 2a.4 测试检查点

- 发送触发 Markdown 回复的问题 → 标题/粗体/斜体/列表/引用正确渲染
- 代码块深色容器 + 语言标签 + Copy 可用
- 行内代码等宽背景
- 流式输出不卡顿

---

## Step 2b: 输入框状态感知

### 2b.1 修改 `Views/Chat/ChatInputBar.swift`

新增参数：`isConnected: Bool`, `isStreaming: Bool`, `onStop: (() -> Void)?`

三态逻辑：
- 正常：可输入，紫色发送按钮
- 流式中：禁用输入，红色 ■ Stop，placeholder "Mantle is thinking..."
- 断开：禁用输入，灰色按钮，placeholder "Backend not connected"

按钮切换：`.contentTransition(.symbolEffect(.replace))`
键盘：Esc 在流式中停止生成，正常态清空输入框

### 2b.2 新增 `AppViewModel.stopActiveStream()`

```swift
func stopActiveStream() {
    chatVM.cancel()
    if let id = activeThreadId, let index = threads.firstIndex(where: { $0.id == id }) {
        threads[index].isStreaming = false
    }
}
```

### 2b.3-2b.4 修改 ChatDetailView + PopoverView

ChatInputBar 调用点传入 isConnected / isStreaming / onStop。

### 2b.5 测试检查点

- 正常态：输入可用，Enter 发送
- 流式中：输入禁用，按钮变红 ■，点击/Esc 停止
- 断开态：输入禁用，红色警告文字

---

## Step 3: 后端自管理

### 3.1 新增 `Services/BackendProcessManager.swift`

ProcessState 枚举：detecting / nodeNotFound / starting / running / restarting(attempt) / startFailed(String) / crashed(String) / stopped

actor BackendProcessManager:
- `stateUpdates: AsyncStream<ProcessState>` 通知外部
- `detectNode()`: 6 级优先级搜索 + version >= v18 校验
- `start()`: 先健康检查 → 检测 node → Process() 启动 → 轮询健康检查 15s
- `handleCrash()`: restartCount < 3 则重启，否则 crashed
- `stop()`: SIGTERM → 2s → SIGKILL
- 注册 `willTerminateNotification` 自动清理

### 3.2 修改 `ViewModels/AppViewModel.swift`

- 新增 `processManager` 属性 + `processState` 状态
- `init` 中创建 ProcessManager，读取 Settings 配置，autoStart 则启动
- `observeProcessManager()`: for await state 映射到 backendStatus
- `shutdown()`: await processManager.stop()

### 3.3 修改 `MantleApp.swift`

注册 `NSApplication.willTerminateNotification` 调用 shutdown。

### 3.4 修改 `Views/Settings/SettingsView.swift`

Connection Tab 新增：
- Auto-start backend Toggle
- Node.js path 文本框 + 文件选择器
- agent-core path 文本框 + 文件夹选择器
- Backend process 状态标签 + Restart/Stop 按钮

### 3.5 测试检查点

- 后端未运行 → app 自动启动 → status 绿色
- 后端已运行 → app 检测到 → 不重复启动
- 手动 kill 后端 → 自动重启（≤3 次）
- 超过 3 次 → crashed + Retry 按钮
- Settings 修改路径 → 生效
- 退出 app → 后端进程终止
