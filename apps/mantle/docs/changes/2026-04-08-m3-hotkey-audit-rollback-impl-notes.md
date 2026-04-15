# M3 桌面整理 + 快捷键 + 审计/回滚 实施记录

**日期**: 2026-04-08
**作者**: Claude
**对应 spec**: Aura 设计文档 M4 (桌面整理) + M5 (打磨)

## M3: 桌面整理

### 问题与解决

1. **`ls ~/Desktop` 返回空**: deepagentsjs 在任何 mode 下都不扩展 `~`。
   - 修复 1: system prompt 指导 LLM 用相对路径 `Desktop`（workspace root = home dir）
   - 修复 2: `agent-core/src/tilde-expand.ts` 中间件自动扩展 `~` 为 `os.homedir()`

2. **virtualMode 路径限制**: `virtualMode: true` 把 `~/Desktop` 当字面路径。
   - 修复: `AGENT_CORE_VIRTUAL_MODE=false`，在 BackendProcessManager.swift 设置

3. **LLM 循环调用 ls**: Gemma 4 收到 home 目录内容后反复 ls 子目录。
   - 修复: system prompt 强调 "One ls call is usually enough"

### agent-core 改动

| 文件 | 说明 |
|------|------|
| `src/tilde-expand.ts` | 新增 `createTildeExpandMiddleware()`，覆盖 ls/read_file/write_file/edit_file/glob/grep |
| `src/system-prompt.ts` | Desktop organization 分步指令，强制 plan-then-execute 流程 |
| `src/agent.ts` | 主 agent + 子 agent 中间件链加入 tilde expand |

### Mantle 改动

| 文件 | 说明 |
|------|------|
| `Services/BackendProcessManager.swift` | workspace=home, virtualMode=false, blocked terms guardrail |

## 快捷键: ⌥Space Toggle

### 改动

| 文件 | 说明 |
|------|------|
| `Services/GlobalHotkeyService.swift` | `cmdKey \| shiftKey` → `optionKey` |
| `MantleApp.swift` | `activateMantle()` 三态 toggle: 前台→隐藏, 后台→唤起, 无窗口→打开 |
| `ViewModels/AppViewModel.swift` | 新增 `shouldFocusInput` |
| `Views/Chat/ChatInputBar.swift` | `requestFocus` Binding + `onChange` 自动聚焦输入框 |
| `Views/MainWindow/ChatDetailView.swift` | 传递 requestFocus 绑定 |
| `Views/MenuBar/PopoverView.swift` | `.constant(false)` |
| `Views/Settings/SettingsView.swift` | 标签 "⌥Space (toggle)" |

## 审计日志 (Audit Log)

### 设计

- 中间件 `createAuditLogMiddleware` 在 `wrapToolCall` 中拦截 write_file/edit_file/execute
- 工具**执行成功后**才记录（先 handler 再 log）
- 输出: `.agent-core/audit.jsonl` (JSONL 格式)
- HTTP: `GET /audit` 返回最近 50 条

### 文件

| 文件 | 说明 |
|------|------|
| `agent-core/src/audit-log.ts` | 中间件 + `parseMvCommands()` 解析 mv 命令 |
| `agent-core/src/settings.ts` | 新增 `auditLogPath`, `movesLogPath` |
| `agent-core/src/agent.ts` | 两处中间件栈加入 audit log |
| `agent-core/src/http.ts` | `GET /audit` 端点 |

## 7 天回滚 (Move Rollback)

### 设计

- audit log 中间件检测 execute 工具中的 `mv` 命令
- 每个 mv 操作记录到 `moves.jsonl`: id, timestamp, sourcePath, destPath
- 回滚 = 反向 mv (`mv destPath sourcePath`)
- 启动时自动清理 >7 天的记录

### 文件

| 文件 | 说明 |
|------|------|
| `agent-core/src/move-tracker.ts` | recordMove/listMoves/rollbackMove/cleanupOldMoves |
| `agent-core/src/http.ts` | `GET /moves`, `POST /moves/:id/rollback` |
| `Mantle/Models/AgentCoreTypes.swift` | MoveRecord, MovesResponse, RollbackResult |
| `Mantle/Services/AgentCoreClient.swift` | moves(), rollbackMove() + getWithQuery helper |
| `Mantle/Views/Settings/RollbackPanel.swift` | 回滚 UI 面板 |
| `Mantle/Views/Settings/SettingsView.swift` | 新增 Rollback tab |

### 踩坑

- `appendingPathComponent("moves?days=7")` 会把 `?` 编码为 `%3F` → 404。改用 `URLComponents` + `queryItems`

## 下一步

- 验证 audit log 和 moves 在实际桌面整理后有数据
- 补充 Rollback 面板的 e2e 测试
- Gemma 4 对 system prompt 指令遵循不稳定，可能需要进一步优化 prompt
