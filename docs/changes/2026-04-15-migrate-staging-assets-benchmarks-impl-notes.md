# 2026-04-15 Migrate Staging Assets and Benchmarks Impl Notes

## Summary

把此前留在 `~/_staging/cortex-public/` 的 `assets/` 与 `benchmarks/` 迁入 mantle-monorepo，并统一将残留的 `Cortex` 品牌名替换为 `Mantle`。迁移后 `~/_staging/` 移入回收站。

## What Changed

- 新增 `assets/`
  - `brand/mantle-app-icon.svg`
  - `images/hero-main-window.svg`、3 个 workflow-*.svg
  - `diagrams/context-to-action-flow.svg`
  - `social/compare-mantle-vs-agents.svg`
  - 各级 README 与 `.gitkeep`
- 新增 `benchmarks/launch/`
  - `prompts/{context-todo,downloads-organize,selection-rewrite}/{prompt.md,cases.json,expected-checks.json}`
  - `fixtures/context/*.json`、`fixtures/selection/*.txt`、`fixtures/downloads-sandbox/default/*`
  - `scripts/live-rehearsal-{runbook,record-template}.md`
  - `README.md`
- 品牌名替换：所有文件内文 `Cortex → Mantle`（含 3 种 casing），两个文件名从 `cortex-*` 改为 `mantle-*`

## Why

- staging 目录里的 assets 与 benchmarks 是正式 monorepo 缺失的素材（品牌图、workflow 示意、发布基准 fixtures 与 runbook），重做成本不低
- 迁入正式仓库后，`README.md` 里"Still planned: screenshots / GIFs / architecture diagrams"有了对应物料
- staging 目录命名残留 `Cortex`，与当前品牌 `Mantle` 统一
