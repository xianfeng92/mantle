# Contributing

感谢你愿意参与 `Mantle Monorepo`。

这个仓库包含两个可以独立运行、也可以组合使用的项目：

- `apps/mantle`：macOS 桌面客户端
- `packages/agent-core`：本地 agent runtime

我们欢迎的贡献方向尤其包括：

- 本地模型适配与推理稳定性改进
- tool runtime / subagent / HITL 体验改进
- 桌面端交互、系统集成与可用性优化
- 文档、上手流程、示例和测试覆盖
- 安全性与权限边界改进

## Before You Start

开始较大改动前，先在 issue、discussion 或草案 PR 里对齐方向，尤其是下面几类工作：

- 新的架构抽象
- 新的 agent protocol / API 约定
- 新的桌面权限或高风险执行能力
- 影响 `Mantle` 与 `agent-core` 边界的改动

小修复、文档修正和局部 UX 改进可以直接提 PR。

## Repo Layout

```text
apps/mantle/         # Swift / SwiftUI macOS app
packages/agent-core/ # TypeScript runtime + HTTP/SSE service
docs/                # Cross-project specs and change notes
```

每个子项目内部也可能有自己的 `docs/`、实现说明和历史 spec。

## Development Setup

### `packages/agent-core`

```bash
cd packages/agent-core
npm install
cp .env.example .env
npm run serve
```

### `apps/mantle`

```bash
cd apps/mantle
open Mantle.xcodeproj
```

如果以完整产品形态联调，先启动 `agent-core`，再运行 `Mantle`。

## Pull Request Guidelines

- 保持 PR 聚焦，避免把无关重构和功能改动混在一起
- 对用户可见行为变化写清楚动机和影响
- 涉及协议、路径发现、权限、后台守护进程时，附带验证步骤
- 改动较大时，更新相关文档或在 `docs/changes/` 留说明
- 如果实现基于现有 spec，请在 PR 描述中引用对应 spec

## Coding Expectations

- 优先保持 `Mantle` 与 `agent-core` 的边界清晰
- 不要让 `Mantle` 直接依赖 `agent-core` 内部实现细节；通过稳定接口协作
- 新增高权限能力时，默认从最小权限、可审计、可关闭的方式设计
- 优先补最小可验证路径，而不是只做结构性重构

## Testing

如果你修改了相关区域，请尽量跑对应检查：

### `agent-core`

```bash
cd packages/agent-core
npm test
```

### `Mantle`

```bash
cd apps/mantle
xcodebuild test -scheme Mantle -destination 'platform=macOS'
```

如果没有运行测试，请在 PR 里直接说明原因。

## Docs

这个仓库偏重设计与实现同步推进。下面这些文档会很有帮助：

- `docs/specs/`：设计规格
- `docs/changes/`：实现说明
- 子项目自己的 `docs/`：更具体的实现背景

对于较大的新能力，先写一个简短 spec 往往比直接写代码更高效。

## Communication

我们欢迎：

- 明确的问题描述
- 带上下文的设计建议
- 对 tradeoff 的真实反馈

如果某个方向还在探索期，也完全可以先提 draft PR。
