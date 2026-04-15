---
title: "Mantle V2 迭代实现记录"
spec: docs/specs/2026-04-06-mantle-iteration-v2-spec.md
plan: docs/specs/2026-04-06-mantle-iteration-v2-impl-plan.md
date: 2026-04-06
author: claude
---

# Mantle V2 — 实现变更说明

## 概述

基于深度体验评估报告，完成 4 项核心优化，将 Mantle 从 "可运行的 demo" 提升为 "可日用的工具"。

## 变更清单

### 1. SwiftData 消息持久化

**新增文件：**
- `Mantle/Models/PersistentModels.swift` — 3 个 `@Model` 类
  - `PersistedThread`、`PersistedMessage`、`PersistedToolEvent`
  - `@Attribute(.unique)` 主键（兼容 macOS 14，未使用 `#Unique` 宏）
  - `@Relationship(deleteRule: .cascade)` 级联删除
  - `sortOrder: Int` 字段保证消息/事件顺序（SwiftData 数组不保序）

**修改文件：**
- `Mantle/Models/ThreadState.swift` — 新增 `init(from: PersistedThread)` 和 `save(to: ModelContext)` 双向转换，完整 upsert 逻辑（按 ID diff，insert/update/delete）
- `Mantle/ViewModels/AppViewModel.swift` — `init(modelContext:)` 注入，`FetchDescriptor` 查询，`migrateFromUserDefaults()` 自动迁移旧数据，流结束时持久化
- `Mantle/MantleApp.swift` — `ModelContainer` 手动创建 + schema 损坏时降级为内存模式

**设计决策：**
- 双层模型策略：`@Model` 类负责存储，现有 struct 负责 SwiftUI 绑定，避免 AnyCodable 与 SwiftData 不兼容
- 持久化时机：用户发送时、流完成/中断/错误时写入，流式 text_delta 期间不写（避免频繁 I/O）

### 2a. Markdown 渲染 + 代码高亮

**新增文件：**
- `Mantle/Views/Chat/MarkdownRenderer.swift`
  - `RenderSegment` 枚举（`.text` / `.codeBlock` / `.blockquote`）
  - `SegmentWalker: MarkupWalker` — 遍历 swift-markdown AST，支持：标题（H1-H4）、段落、有序/无序列表、加粗/斜体、行内代码、链接、代码块、引用块、表格、分隔线
  - `MarkdownContentView` — 按 segments 组合渲染

- `Mantle/Views/Chat/CodeBlockView.swift`
  - 深色背景（`#1e1e2e`）圆角容器
  - 顶部栏：语言标签 + Copy 按钮（1.5s ✓ 反馈）
  - `SyntaxHighlighter` — 正则高亮，Catppuccin Mocha 配色
  - 支持 11 种语言：Swift, Python, JS, TS, Go, Rust, Shell, HTML, CSS, JSON, YAML
  - 异步高亮（`.task {}` 中执行，先显示无高亮文本）

**修改文件：**
- `Mantle/Views/Chat/MessageBubble.swift` — assistant 消息从 `Text()` 改为 `MarkdownContentView()`

### 2b. 输入框状态感知

**修改文件：**
- `Mantle/Views/Chat/ChatInputBar.swift` — 三态逻辑：
  - **正常态**：输入可用，紫色 ↑ 发送按钮，Enter 发送
  - **流式中**：输入禁用，红色 ■ Stop 按钮，Esc 停止，`.contentTransition(.symbolEffect(.replace))` 动画
  - **断开态**：输入禁用，橙色 "Backend not connected" 警告
- `Mantle/Views/MainWindow/ChatDetailView.swift` — 传入 `isConnected` / `isStreaming` / `onStop`
- `Mantle/Views/MenuBar/PopoverView.swift` — 同上

### 3. 后端进程自管理

**新增文件：**
- `Mantle/Services/BackendProcessManager.swift`
  - `ProcessState` 枚举：detecting / nodeNotFound / starting / running / restarting / startFailed / crashed / stopped
  - `BackendProcessManager` actor：
    - `detectNode()` — 6 级优先级搜索（用户配置 > Homebrew ARM > Homebrew Intel > nvm > Volta > /usr/bin/env）+ `node --version` ≥ v18 校验
    - `start()` — 先检测后端是否已运行 → 检测 node → Process() 启动 → 健康检查轮询 15s
    - `handleTermination()` — 非正常退出自动重启（≤3 次，间隔 2s），超限标记 crashed
    - `stop()` — SIGTERM → 等 2s → SIGKILL
    - `stateUpdates: AsyncStream<ProcessState>` 对外通知
    - `willTerminateNotification` 注册，app 退出时自动清理

**修改文件：**
- `Mantle/ViewModels/AppViewModel.swift` — 集成 `processManager`，`observeProcessManager()` 消费状态流映射到 `backendStatus`，`shutdown()` / `restartBackend()`，autoStart 开关
- `Mantle/Views/Settings/SettingsView.swift` — Connection Tab 新增 Backend Process 区块：
  - Auto-start toggle
  - Node.js / agent-core 路径配置 + 文件选择器
  - 进程状态标签 + Restart / Stop / Retry 按钮

## 额外修复

### 空 assistant 消息气泡
- **问题**：`streamingStarted` 每次都创建空占位消息，工具调用 → 回复文本场景下会残留空气泡
- **修复**：
  1. `streamingStarted` 检查最后一条 assistant 是否已空，避免重复创建
  2. `completed` 时清理所有空 assistant 消息（text 为空且无 toolEvents）

## 文件变更汇总

| 动作 | 文件 | Step |
|------|------|------|
| 新增 | `Models/PersistentModels.swift` | 1 |
| 新增 | `Views/Chat/MarkdownRenderer.swift` | 2a |
| 新增 | `Views/Chat/CodeBlockView.swift` | 2a |
| 新增 | `Services/BackendProcessManager.swift` | 3 |
| 修改 | `Models/ThreadState.swift` | 1 |
| 修改 | `ViewModels/AppViewModel.swift` | 1, 2b, 3 |
| 修改 | `MantleApp.swift` | 1 |
| 修改 | `Views/Chat/MessageBubble.swift` | 2a |
| 修改 | `Views/Chat/ChatInputBar.swift` | 2b |
| 修改 | `Views/MainWindow/ChatDetailView.swift` | 2b |
| 修改 | `Views/MenuBar/PopoverView.swift` | 2b |
| 修改 | `Views/Settings/SettingsView.swift` | 3 |

**合计**：4 个新增文件，8 个修改文件。构建通过，功能验证通过。

## 已知限制

- Markdown 流式渲染无节流（当前每次 text_delta 触发完整解析，大文本可能卡顿）
- 语法高亮为正则方案，无 Tree-sitter 级精确度
- BackendProcessManager 未持久化日志（stdout/stderr 捕获但未展示）
- 沙盒环境下 Process() 启动外部进程需要 entitlements 配置
