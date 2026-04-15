---
title: "Mantle Monorepo 开源收敛"
status: implemented
owner: codex
created: 2026-04-15
updated: 2026-04-15
implements:
  - root-readme
  - root-gitignore
  - monorepo-layout
reviews: []
---

# Mantle Monorepo 开源收敛

## Context

目标是把 `Mantle` 与 `agent-core` 收敛到一个统一开源仓库中，同时保持它们作为独立前后端继续运行和演进。

## Decision

采用 monorepo 结构：

- `apps/mantle`
- `packages/agent-core`
- `docs/`

迁移策略不是保留旧仓库历史，而是以当前工作树快照为基础创建新的统一仓库起点。

## Implemented

1. 从现有 `Mantle` 与 `agent-core` 目录拷贝源码快照进入新 monorepo
2. 过滤本机缓存、运行时目录、依赖目录与嵌套 Git 元数据
3. 新增根级 `README.md` 与 `.gitignore`
4. 调整 `Mantle` 的 `agent-core` 路径发现逻辑，使其优先兼容 `packages/agent-core`
5. 更新 `apps/mantle/README.md` 以匹配新定位与新路径
