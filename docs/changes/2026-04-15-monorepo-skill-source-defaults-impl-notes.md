# 2026-04-15 Monorepo Skill Source Defaults Impl Notes

## Summary

为 monorepo 结构补齐 `agent-core` 的 skill source / subagent source 默认路径，使工作区切到仓库根目录后仍能自动发现 `packages/agent-core/.deepagents/...`。

## What Changed

- `packages/agent-core/src/settings.ts`
  - 当 `AGENT_CORE_SKILL_SOURCE_PATHS` 未显式设置时，若工作区根目录下存在 `packages/agent-core/.deepagents/skills`，自动使用该路径
  - 当 `AGENT_CORE_SUBAGENT_SOURCE_PATHS` 未显式设置时，若工作区根目录下存在 `packages/agent-core/.deepagents/subagents`，自动使用该路径
- `apps/mantle/Mantle/Services/BackendProcessManager.swift`
  - Mantle 拉起后端时，会基于当前工作区自动设置相对的 skill / subagent source 路径

## Why

在 monorepo 模式下，`workspaceDir` 通常是仓库根目录，而不是 `packages/agent-core` 本身。原有默认值只查找 `.deepagents/skills` 和 `.deepagents/subagents`，导致：

- skills 发现数量下降
- subagent source 丢失

修正后，monorepo 根工作区与 `agent-core` 单仓工作区都能保持更自然的默认行为。
