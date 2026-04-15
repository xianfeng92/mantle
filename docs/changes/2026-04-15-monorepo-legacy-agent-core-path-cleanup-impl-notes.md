# 2026-04-15 Monorepo Legacy agent-core Path Cleanup Impl Notes

## Summary

清理 monorepo 中仍然指向旧 `/Users/xforg/AI_SPACE/agent-core` 目录的文档和测试路径，避免在删除旧目录后继续出现误导或路径失效。

## What Changed

- 更新 `packages/agent-core` 下 README、`CLAUDE.md` 与历史实现说明中的示例命令
- 更新 `packages/agent-core/tests/smoke-iterations.test.ts` 中硬编码的 spec 路径
- 更新 `apps/mantle` 历史 spec 中关于 `agent-core path` 默认值的描述

## Why

旧 `AI_SPACE/agent-core` 已不再是当前运行时依赖。保留这些路径会导致：

- 文档继续指向旧目录
- 测试在旧目录删除后失效
- 清理阶段难以判断哪些引用仍然有效
