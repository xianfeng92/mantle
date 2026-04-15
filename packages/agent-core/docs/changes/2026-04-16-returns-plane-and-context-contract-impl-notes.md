# Returns Plane + Context Assembly Contract —— 实施笔记

**Date**: 2026-04-16
**Implements**: `docs/specs/2026-04-16-returns-plane-spec.md`, `docs/specs/2026-04-16-context-assembly-contract-spec.md`

## 背景

阅读 ZeroClaw v0.3 架构文档后，为 Mantle 选了两个 P0 动作：

- **P0-1**：在 Mantle 还只有一条活跃入口路径时，立上下文装配契约，避免 ZeroClaw 踩过的"多入口独立演化→上下文装配分叉"包袱
- **P0-2**：把 ZeroClaw 的 Returns Plane 抽象落到 Mantle，作为 ambient / 后台任务的统一出口；下一步 `twitter-digest` 和未来的 heartbeat worker 都挂到这个平面上

两个 P0 一起做：spec 要写的 Review 条件 #1（新增一条不走 `AgentCoreServiceHarness` 的 path）本来就包括 Returns Plane 的 HTTP 端点，顺便在同一 commit 里兑现契约里的"CRUD + subscribe 属于 Direct caller"声明。

## 改动清单

### P0-1：契约 spec（只加文档）

- `docs/specs/2026-04-16-context-assembly-contract-spec.md`

登记当前 5 条已知 path（http-run / http-run-stream / http-resume / cli-repl / twitter-digest），定义 4 条硬规则和新增入口 checklist。

### P0-2：Returns Plane 基础设施

**新增**：

- `src/returns.ts` —— `ReturnStore`（JSONL 持久化，沿用 `MemoryStore` 的同款 read/append/writeAll + FIFO cap 模式）+ `ReturnDispatcher`（store + EventEmitter 广播）
- `tests/returns.test.ts` —— store CRUD / since / unackedOnly / FIFO / 损坏行跳过 / dispatcher 广播与取消订阅（6 个 case，全绿）
- `docs/specs/2026-04-16-returns-plane-spec.md`

**改动**：

- `src/settings.ts` —— 新增 `returnsLogPath` 字段，env `AGENT_CORE_RETURNS_LOG_PATH` 可覆盖，默认 `<dataDir>/returns.jsonl`
- `src/agent.ts` —— `AgentRuntime` 增加 `returnStore` + `returnDispatcher`；`createAgentRuntime` 装配
- `src/http.ts` —— 新增 6 个端点：
  - `GET /returns`（支持 `limit` / `since` / `unackedOnly`）
  - `GET /returns/:id`
  - `POST /returns`
  - `POST /returns/:id/ack`
  - `DELETE /returns/:id`
  - `GET /returns/stream`（SSE + 30s keep-alive）
- `tests/http.test.ts`、`tests/service.test.ts`、`tests/smoke-iterations.test.ts` —— `AgentRuntime` fake 对象补 `returnStore` / `returnDispatcher` 字段，保持 typecheck 通过

## 明确不做（避免 scope creep）

- `twitter-digest` 改走 Returns Plane —— 下一步单独 PR，保持本次改动聚焦"基础设施"
- Heartbeat worker —— 这是 P1，等 Returns Plane 在生产里跑过再上
- `ReturnEntry.announce.channels` 的枚举收敛 —— spec 已标记为"先让发布方随便填"
- macOS 客户端消费端 —— Swift 侧由 `apps/mantle` 单独跟进

## 验证

- `npm run typecheck` ✅
- `npx tsx --test tests/returns.test.ts` → 6/6 ✅
- `npx tsx --test tests/http.test.ts tests/service.test.ts tests/settings.test.ts tests/memory.test.ts` → 47/47 ✅

## Follow-up 建议

1. 新开 PR：把 `POST /twitter/digest` 的 `daily` / `weekly` 产出默认 dispatch 到 Returns Plane，request body 可用 `persist: false` 显式关闭
2. Mantle macOS 客户端：菜单栏加一个"Inbox"入口，拉 `GET /returns?unackedOnly=true` + 订阅 `/returns/stream`
3. 未来新增入口（ACP / 全局热键 / Shortcuts.app）前，先在 context-assembly-contract 的 Path Row 表格里登记
