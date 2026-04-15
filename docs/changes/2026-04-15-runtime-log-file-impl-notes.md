# 2026-04-15 Runtime Log File Impl Notes

## Summary

为 `Mantle` 增加了一个可落盘、可 `tail -f` 的运行时日志文件，方便在 app 外部实时观察发送消息、SSE、HTTP 与后端子进程行为。

## What Changed

- 新增 `RuntimeLogStore`，将关键运行事件写入 `~/Library/Application Support/Mantle/logs/runtime.log`
- 新增 `MantleLog.runtime(...)` 辅助方法，用于把关键事件同时写入文件日志
- 为以下关键链路增加文件日志：
  - `AppViewModel.send`
  - `ChatViewModel` 的 send / resume 生命周期
  - `SSEStreamClient` 连接、重试、失败、结束
  - `AgentCoreClient` 的关键 GET / POST 请求错误
  - `BackendProcessManager` 的启动、健康检查、崩溃与 stdout/stderr 缓冲

## Why

原本日志主要分布在：

- `os.Logger`（对外部抓取不稳定）
- app 内部 Settings 的 process log buffer（只在 UI 中可见）

新增文件日志后，可以直接在终端执行：

```bash
tail -f "$HOME/Library/Application Support/Mantle/logs/runtime.log"
```

从而让外部协作调试更直接。
