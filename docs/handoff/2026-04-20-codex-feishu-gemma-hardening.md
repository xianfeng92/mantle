# Codex 交接任务 — Feishu × Gemma 4 26B 硬化

> 复制本文件全文粘给 Codex 即可。Codex 在动手前应当先按【入场前必读】读完引用的 spec。

---

## 背景（1 分钟读完）

**Mantle** 是 macOS 本地 AI agent 项目，monorepo：
- `apps/mantle/` — SwiftUI 客户端
- `packages/agent-core/` — TypeScript agent runtime（基于 deepagents + LangChain）

**最近刚做完**的事（最新 commit 已经落盘到 main）：
- Channel trait + dispatcher 骨架（`src/channels/*`，spec：`docs/specs/2026-04-17-channel-trait-spec.md`）
- 飞书 channel 接入 + 端到端通过（WebSocket + 交互卡片 + HITL 按钮）
- 第一个 skill `/summarize`（在飞书 slash command 里）
- Returns Plane / Heartbeat / Media Pipeline / Interruption Scope 都已在 main

**当前核心问题**：本地 Gemma 4 26B 在 24 个工具池里做 tool selection 命中率很低，导致飞书里简单问题（"当前工作目录"）会连环调 pwd → ls → ls... 产生大量 HITL 审批。

**应对策略**：让环境更简单，不让模型更听话。按 channel 暴露不同 tool profile。

### 入场前必读

```
packages/agent-core/CLAUDE.md
packages/agent-core/docs/specs/2026-04-17-channel-trait-spec.md
packages/agent-core/docs/specs/2026-04-16-context-assembly-contract-spec.md
packages/agent-core/src/channels/channel.ts          (Channel interface)
packages/agent-core/src/channels/dispatcher.ts       (ChannelDispatcher)
packages/agent-core/src/channels/feishu.ts           (already migrated + has /summarize)
packages/agent-core/src/system-prompt.ts             (compact profile + buildCompactSystemPrompt)
packages/agent-core/src/agent.ts                     (createCompactAgentInvoker)
```

---

## 硬约束（所有任务都适用）

1. **不要改 Swift 代码** — 不在本次任务范围（Xcode 构建 Codex 跑不起来）
2. **每个任务单独一个 commit**，commit message 按现有风格（lowercase `feat:` / `fix:` / `chore:` 前缀，中文 body 可以）
3. **所有改动必须通过**：
   - `cd packages/agent-core && npm run typecheck`
   - `cd packages/agent-core && npx tsx --test tests/channels.test.ts tests/http.test.ts tests/service.test.ts tests/heartbeat.test.ts tests/returns.test.ts tests/settings.test.ts tests/feishu-post.test.ts`
   - `cd packages/agent-core && npm run build`（重要！Mantle 启动后端时跑 `dist/src/serve.js`）
4. **不要改 `.env` / `packages/HEARTBEAT.md` / `.claude/` / `DerivedData/`** 这些是用户本地状态
5. **不做大重构**。每个 task 目标是具体的改动，不是顺便 clean up
6. **不加新依赖**除非 task 明确要求（目前 `yaml` 已装，别的能不装就不装）
7. **不跑真实的 LLM 测试** — LM Studio 没在 Codex 端起。测试只测纯逻辑
8. **commit message 里不要自称 Codex**，就用常规的工程师风格

---

## 任务清单（按优先级，一个一个做，做完一个提交一个）

### P0-1 · Channel-aware Tool Filter Middleware

**目标**：让飞书 channel 里 Gemma 只看到 5 个工具，不看到 15 个 computer-use 工具和 `execute`。

**问题回顾**：现在飞书里问一句话，Gemma 从 ~24 工具池里选，经常选到 `execute` / `open_app` / `ui_tree`，触发 HITL。IM 场景根本用不到 GUI 控制。

**实现方案**（倾向 "middleware 层面过滤"，不要改 agent 构建）：

1. 新文件 `packages/agent-core/src/channels/tool-profile.ts`：
   ```ts
   export type ToolProfile = "chat" | "desktop" | "readonly" | "full";
   
   export const TOOL_PROFILE_ALLOWLISTS: Record<ToolProfile, Set<string>> = {
     chat:     new Set(["ls","read_file","glob","grep","write_todos"]),
     readonly: new Set(["ls","read_file","glob","grep"]),
     desktop:  new Set(),  // empty means "pass through everything"
     full:     new Set(),  // alias for desktop
   };
   
   export function filterToolsByProfile<T extends { name: string }>(
     tools: readonly T[],
     profile: ToolProfile,
   ): T[] {
     const allow = TOOL_PROFILE_ALLOWLISTS[profile];
     if (allow.size === 0) return [...tools];
     return tools.filter((t) => allow.has(t.name));
   }
   ```

2. `ChannelMessage` 加可选字段 `toolProfile?: ToolProfile` （在 `src/channels/channel.ts`）。

3. `FeishuChannel.onMessage` 把 ChannelMessage 的 `toolProfile` 设为 `"chat"`。

4. 最难的一步：**让 agent.streamRun 接受 per-turn tool filter**。deepagents 的 middleware 链是 build-time 固定的，我们要做 runtime 过滤。两种实现选择（Codex 自选更干净的）：
   - **选项 A**（推荐）：在 `service.ts::buildInputMessages` 后插一个 LangGraph middleware，读 `config.configurable.toolProfile`，过滤 state 里可见的 tools。
   - **选项 B**：在 `ChannelDispatcher` 层面，dispatcher 构建 per-scope 的 agent instance pool（太重，不推荐）。

   如果选项 A 受 deepagents 架构限制实现不了，**fallback**：在 `system-prompt.ts` 里把 allowlist 硬编码进 prompt，告诉 Gemma "只允许用 ls / read_file / glob / grep / write_todos 这 5 个"。虽然 prompt-based 不够硬，但比现状好。

5. 加单元测试 `tests/tool-profile.test.ts` 测 `filterToolsByProfile` 纯逻辑。

**验收**：
- `npm run typecheck` + `npm run build` 通过
- `tests/tool-profile.test.ts` 绿
- 现有测试全绿（无回归）
- 如果走选项 A：在 `service.test.ts` 加一个 case 验证 `streamRun({ scopeKey: ..., toolProfile: "chat" })` 时 tool list 被过滤

**不要**：
- 不要改 `deepagents` 包本身
- 不要把 `toolProfile` 挤进 `scopeKey`
- 不要删 `createComputerUseMiddleware` 调用（桌面还要用）

---

### P0-2 · Computer-use 瘦身：只留 thick 工具

**目标**：`computer-use.ts` 里 15 个工具里有一半是 "裸" 工具（`click` / `type_text` / `click_element`），对应的 "厚" 工具（`click_element_and_wait` / `set_value_and_verify` / `press_shortcut_and_verify`）已经涵盖更稳的语义。只留厚的。

**做法**：

1. 读 `packages/agent-core/src/computer-use.ts` 找所有 `name: "xxx"` 的 tool 定义。
2. 保留：`observe_frontmost_ui`, `screenshot`, `open_app_and_observe`, `click_element_and_wait`, `set_value_and_verify`, `press_shortcut_and_verify`, `ui_tree`, `run_actions`（8 个）
3. 移除：`click`, `type_text`, `key_press`, `scroll`, `click_element`, `set_element_value`, `open_app`（7 个）
4. 同步更新 `src/system-prompt.ts` 里 "Computer use" 章节提到的工具名（把不存在的工具从 prompt 里删）
5. 搜索全仓 `grep -rn "click_element\\|open_app\\|type_text\\|key_press\\|set_element_value\\|scroll\\b"` — 如果有测试或 skill 引用了这些名字，改/删

**验收**：
- 同上三项通过
- 现有测试没因此失败；如果有测试 reference 了裸工具名，改成厚版本或删除该测试 case

**不要**：
- 不要改 Mantle app 侧的 computer-use HTTP server（`ComputerUseServer.swift`）—— 那是对外协议层，裸 endpoint 可以保留，只是 agent 不暴露这些 tool 而已

---

### P1-1 · 飞书审批卡片 "processing" UX

**目标**：用户点了 Approve 之后，卡片应该立刻 patch 成 "✅ Approved · processing…"（按钮消失），避免重复点。

**问题回顾**：现在点一次 Approve → cardAction 触发 → streamResume 跑 10+ 秒 → 这期间用户可能又点一次；每一次点都进一次 onCardAction，虽然有 scope 保护，但 UX 是"像没响应"。

**做法**：

1. 在 `FeishuChannel.onCardAction` 里，**拿到 cardAction 的原卡片 messageId**（飞书 SDK 的 event payload 里通常在 `event.open_message_id` / `event.message_id` / 某个位置；先 log 一把 raw event 看结构，再精准提取）。
2. 收到 action 的**第一时间**（在开 streamResume 之前）：`patchCard(originalMessageId, buildProcessingCard(action))`。
3. 新增卡片构造器 `buildProcessingCard(action: "approve" | "reject"): unknown`，内容就是标题 + "✅ Approved · 处理中…" 或 "❌ Rejected"，**没有按钮**。
4. 如果拿不到 originalMessageId，fallback 行为维持现状（不要 crash）。

**验收**：
- 上面三项通过
- 单元测试不强制（依赖 Feishu SDK 事件 shape），但如果你有把握可以加一个测试来验证 `buildProcessingCard` 的结构

**不要**：
- 不要改 scope 逻辑（上个 PR 已经修好了）
- 不要去除原有 cardAction 的 dedup/preempt 机制

---

### P1-2 · 清理 "no im.message.message_read_v1 handle" 警告

**目标**：飞书 SDK 反复打 `[warn] no im.message.message_read_v1 handle`，日志里巨吵。注册一个空 handler 静默掉。

**做法**：

在 `FeishuChannel.start` 的 `eventDispatcher.register({...})` 里，把这几个常见的飞书事件都注册为 no-op：

```ts
"im.message.message_read_v1": async () => {},
"im.message.reaction.created_v1": async () => {},
"im.message.reaction.deleted_v1": async () => {},
"im.message.recalled_v1": async () => {},
```

（实际需要静默的 list 以 runtime.log 里出现的为准，Codex 可以搜一下历史 log 找还有哪些。）

**验收**：typecheck + build + 现有测试绿。

**不要**：不要真的 process 这些事件，就是 no-op 静默。

---

### P1-3 · Spec 状态核对

**目标**：`packages/agent-core/docs/specs/` 下有两个 spec 状态是 `ready` 但代码实际已实现：

- `2026-04-13-sandbox-spec.md` (代码在 `src/sandbox.ts`)
- `2026-04-13-skill-format-spec.md` (代码在 `src/skills.ts`)

**做法**：

1. 读两个 spec 的内容，对照 `src/sandbox.ts` 和 `src/skills.ts`，**判断实现是否真的覆盖了 spec 的所有必做项**
2. 如果完全覆盖 → 更新 frontmatter：`status: ready` → `status: implemented`，`implements:` 列出指向的 changes 文档（如果有）或直接指 src 文件路径
3. 如果部分覆盖 → 保持 `ready`，在 spec 末尾加 `## Implementation notes` 章节说清"已实现 X / 未实现 Y"

**验收**：git diff 清爽，只改 spec 的 frontmatter + 可能的 notes 章节。

---

### P2-1 · 第二个 Skill：`/find <keyword>`

**目标**：在飞书里输入 `/find channel dispatch` 返回 workspace 里匹配的前 5 个文件 + 片段。这是继 `/summarize` 之后第二个 Gemma-friendly skill。

**为什么做这个**：`/summarize` 验证了 0 工具 skill 的甜蜜点；`/find` 是下一个甜蜜点验证 —— **3 工具（grep / ls / read_file）** 的窄 agent loop 下 Gemma 表现。

**做法**：

1. 在 `FeishuChannel.handleSlashCommand` 加 case：
   ```ts
   case "/find":
   case "/search": {
     const keyword = raw.slice(cmd.length).trim();
     if (!keyword) {
       await this.sendTextMessage(chatId, "用法：`/find <关键词>` — 在 workspace 里搜代码");
       return;
     }
     await this.runFindSkill(chatId, keyword);
     return;
   }
   ```

2. `runFindSkill` **不走 agent loop**，用**确定性代码**实现（和 Gemma 能力无关，也避免 HITL 审批）：
   - 调 shell `grep -rn --include="*.ts" --include="*.swift" --include="*.md" -l "<keyword>" <workspaceDir>` 拿匹配文件列表（限 20 个）
   - 对每个命中文件，再 `grep -n "<keyword>"` 拿前 3 行内容
   - 渲染成 Markdown：
     ```
     **5 个文件匹配 "channel dispatch"**
     - `packages/agent-core/src/channels/dispatcher.ts`
       ```
       L12: class ChannelDispatcher {
       L47: async dispatch(message: ChannelMessage)
       ```
     ...
     ```
   - 用 `sendDraft` → `finalizeDraft` 流式卡片

3. 如何拿 workspaceDir：`this.service.settings.workspaceDir`（用 P0-1 之前已经加的 public getter `service.settings`）

4. 复用 `sendInteractiveCard` / `patchCard` 发 Markdown 卡片

5. 更新 `/help` 文案，加上 `/find`

**验收**：
- 同上三项通过
- **不用**写单元测试（涉及 shell 执行，集成测更合适，先靠手工验证）

**不要**：
- **不要用 agent loop / LLM**。这个 skill 是纯确定性的，就是 shell grep + 格式化。你可能有冲动让 Gemma "理解 keyword intent"，忍住。我们的设计原则是"0-3 工具、无 LLM 决策、固定 schema"。
- 不要让它支持 glob / 正则参数 — 只支持纯字符串搜索，v1 就这样
- 不要跨出 `workspaceDir` 边界 — 用 `node:path` 判断

---

## 不做的任务（给 Codex 的禁区，避免自己发挥）

以下任务**不在本次交接范围**，Codex 看到请跳过：

- 创建 `/Users/xforg/AI_SPACE/mantlehome/HEARTBEAT.md`（内容决策需要用户判断）
- 改 Mantle Swift 代码（`apps/mantle/**`）
- 迁移 `twitter-digest` 到 Heartbeat engine（需要设计决策）
- 实现 Policies 引擎（P3，不紧迫）
- 给 Mantle 桌面端接入 Draft lifecycle（需要 SwiftUI 改造）
- 任何涉及 push 到 git remote 的操作（只 local commit）

---

## 完成后汇报格式

每做完一个任务：

```
### Task P0-1: Channel-aware Tool Filter
- Commit: <hash>
- Files changed: (list)
- Tests: 19/19 passed (X new)
- Build: ok
- Notes: 走了 option A / B / fallback（说明为什么）,any tradeoff
```

所有任务做完，最后给一个总结 checklist。

---

## 上下文锚点（一些容易踩的坑）

1. **`npm run build` 是必须的** — Mantle app 启动后端时跑 `dist/src/serve.js`，不是 `tsx src/serve.ts`。不 build，Mantle 用的还是旧代码，调试会混乱
2. **worktree 目录** — 如果仓库有 `.claude/worktrees/*`，编辑文件用绝对路径或先确认 cwd，免得改错位置（我之前踩过这个坑）
3. **Feishu SDK 是 optionalDependency** — 本地 npm install 时带 `--no-optional` 不装也能 build（用 `type stub`），所以 Codex 改 `feishu.ts` 即使 SDK 没装也能 typecheck
4. **飞书 SDK event payload shape 可变** — 同一事件在不同 SDK 版本下 structure 略不同，处理时写 defensive parser（参考现有 `extractCardActionValue`）
5. **deepagents 的 middleware 链是 build-time 确定的** — P0-1 要做的 runtime tool filter 可能需要一些巧思；如果卡住，用 fallback (prompt-based) 也是可接受的
