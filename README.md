# Mantle Monorepo

`Mantle Monorepo` 是一个面向本地 AI agent 的开源工作仓库，当前包含两个可以独立运行、也可以组合使用的项目：

- `apps/mantle`：原生 macOS 桌面客户端，负责 UI、权限、系统集成与桌面能力
- `packages/agent-core`：本地 agent runtime，负责模型接入、工具编排、HTTP/SSE 服务和执行状态

这两个项目共享同一套产品方向，但保持前后端边界清晰：

- `Mantle` 通过 HTTP/SSE 调用 `agent-core`
- `agent-core` 可以被 `Mantle` 使用，也可以单独作为 CLI / HTTP 服务运行
- 同一个仓库方便统一文档、roadmap、issues 与发布节奏

## Repository Layout

```text
mantle-monorepo/
├── apps/
│   └── mantle/
├── packages/
│   └── agent-core/
└── docs/
```

## Quick Start

### 1. Start agent-core

```bash
cd packages/agent-core
npm install
cp .env.example .env
npm run serve
```

### 2. Launch Mantle

```bash
cd apps/mantle
open Mantle.xcodeproj
```

默认情况下，`Mantle` 会优先尝试在 monorepo 布局中发现 `packages/agent-core`，因此本仓库结构下不需要额外配置后端路径。

## Project Roles

### `apps/mantle`

- Swift / SwiftUI macOS app
- 全局热键、菜单栏、通知、语音、Spotlight、桌面控制
- 负责把 agent 能力变成桌面交互体验

### `packages/agent-core`

- TypeScript local agent runtime
- LLM adapter、tool runtime、multi-agent harness、HTTP/SSE service
- 负责模型推理、工具调用、线程状态和执行流程

## Open Source Status

当前仓库已经完成 monorepo 收敛，可作为统一开源仓库继续演进。许可证与对外发布素材仍建议在正式公开前补齐：

- `LICENSE`
- `CONTRIBUTING.md`
- `SECURITY.md`
- 截图 / GIF / 架构图

## Notes

- `apps/mantle` 和 `packages/agent-core` 仍然保留各自 README，方便独立阅读和开发
- 本次仓库整理按当前工作树快照迁移，优先确保现状可继续开发，而不是保留旧仓库历史
