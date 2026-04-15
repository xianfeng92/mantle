# 2026-04-15 Monorepo Open Source Impl Notes

## Summary

将 `Mantle` 与 `agent-core` 收敛到 `/Users/xforg/AI_SPACE/mantle-monorepo`，形成一个适合继续整理为开源项目的统一仓库骨架。

## What Changed

- 新建 monorepo 根目录与 `apps/`、`packages/`、`docs/` 结构
- 拷贝 `Mantle` 当前工作树到 `apps/mantle`
- 拷贝 `agent-core` 当前工作树到 `packages/agent-core`
- 排除 `.git`、`node_modules`、`.agent-core`、`.claude`、本机缓存与运行时目录
- 新增根级 `README.md` 和 `.gitignore`
- 更新 `Mantle` 的后端路径自动发现逻辑，兼容 `packages/agent-core`
- 修正 `apps/mantle/README.md` 中仍使用 `Cortex` 旧名和旧路径的问题

## Follow-up

- 选择并补齐最终开源许可证
- 增加 `CONTRIBUTING.md`、`SECURITY.md`
- 为根 README 补截图、架构图和安装验证流程
