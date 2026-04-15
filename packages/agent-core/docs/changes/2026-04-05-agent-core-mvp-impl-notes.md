# Agent Core MVP 实现说明

> 历史记录：本文档描述的是 2026-04-05 的 Python MVP 快照；相关源码已在同日切换到 `deepagentsjs` 实现后从仓库移除。

## 本次实现范围

按 `docs/specs/2026-04-05-agent-core-design-spec.md` 实现了第一版可运行 MVP：

- `src/agent_core/core/`
  - `Message` / `ToolCall` / `MessageStore`
  - `ToolDefinition` / `ToolResult` / `PermissionProfile`
  - `ToolRegistry` 和 `@tool`
- `src/agent_core/harness/`
  - `Runner`
  - `PermissionPolicy`
  - `HookRegistry`
- `src/agent_core/llm/`
  - `OpenAICompatibleClient`
  - `OpenAIParser`
  - `Gemma4Parser`
  - `ContentFallbackParser`
  - `AutoParser`
- `src/agent_core/interface/cli.py`
  - `CLIHarness`
- `tools/`
  - `read_file`
  - `write_file`
  - `glob_files`
  - `grep_search`
  - `run_command`
- `main.py`
- `pyproject.toml`
- `tests/`

## 关键实现决策

- Runner 将权限确认作为协议的一部分，通过 `permission_resolver` 注入，而不是写死在 CLI 里
- 单轮多个 tool calls 按返回顺序串行执行
- 工具输出统一归一化为 `ToolResult`
- 默认权限决策基于 `PermissionProfile`
- Gemma4Parser 第一版只支持扁平参数对象

## 验证结果

已执行：

- `python3 -m unittest discover -s tests -t . -v`
- `python3 -m compileall src tools main.py`

结果：

- 13 个单元测试全部通过
- 语法编译检查通过

## 备注

- 直接运行测试时推荐使用 `python3 -m unittest discover -s tests -t . -v`，这样 `tests/__init__.py` 会正确引导 `src/` 路径
- 当前未实现 streaming、并行工具调用、context compaction、tracing 和 Android 端移植
