---
title: Gemma computer-use P0/P1 implementation notes
date: 2026-04-12
---

# Summary

Implemented the first Gemma-focused control loop changes for `agent-core`:

- weakened one-shot `computer-use` in favor of short loops
- introduced thicker GUI tools with built-in wait/verify behavior
- added stage-based tool exposure (`observe -> act -> verify`)
- added traceable verification / staging diagnostics
- surfaced diagnostics in the web UI

# What Changed

## 1. Computer-use default path is now short-loop oriented

Updated `/src/computer-use.ts` to make the default tool surface Gemma-friendly:

- added `observe_frontmost_ui`
- added `open_app_and_observe`
- added `click_element_and_wait`
- added `set_value_and_verify`
- added `press_shortcut_and_verify`
- kept `type_text` for focused editor flows
- removed `run_actions` from the default middleware tool set
- kept low-level tools (`run_actions`, `click`, `scroll`, `screenshot`, raw element tools) as debug/internal tools only

Each thick GUI tool now performs built-in waiting and compares `ui_tree` snapshots before/after.

## 2. Added tool staging middleware

Added `/src/tool-staging.ts`.

This middleware:

- infers a stage from the current conversation and recent tool calls
- narrows the visible tools per model call
- enforces a verify step after filesystem or GUI actions
- enforces a hard GUI action budget (`8` steps by default)

Stages currently used:

- `observe`
- `act_fs`
- `act_gui`
- `verify`
- `budget_exhausted`

## 3. Added lightweight verification for filesystem and execute tools

Inside `tool-staging.ts`:

- `write_file` and `edit_file` now perform readback checks through the backend
- `execute` now appends normalized exit-code verification guidance
- verification pass/fail is recorded into trace events

This is a P0/P1 version, not the final P2 unified verification abstraction.

## 4. Diagnostics and observability expanded

Updated tracing and diagnostics to record and aggregate:

- stage selections
- verification pass/fail
- GUI step budget exhaustion
- average tool calls per run
- average GUI action steps per run
- compaction rate
- recent context usage

Updated `/src/service.ts` to pass `trace_id` into middleware and to capture token usage in streaming completions.

## 5. Web UI now shows runtime diagnostics

Updated the web client to fetch `/diagnostics` and display:

- context usage
- compaction count
- verification counts
- average GUI action steps
- stage distribution

# Files

- `/Users/xforg/AI_SPACE/mantle-monorepo/packages/agent-core/src/computer-use.ts`
- `/Users/xforg/AI_SPACE/mantle-monorepo/packages/agent-core/src/tool-staging.ts`
- `/Users/xforg/AI_SPACE/mantle-monorepo/packages/agent-core/src/agent.ts`
- `/Users/xforg/AI_SPACE/mantle-monorepo/packages/agent-core/src/system-prompt.ts`
- `/Users/xforg/AI_SPACE/mantle-monorepo/packages/agent-core/src/service.ts`
- `/Users/xforg/AI_SPACE/mantle-monorepo/packages/agent-core/src/http.ts`
- `/Users/xforg/AI_SPACE/mantle-monorepo/packages/agent-core/src/tracing.ts`
- `/Users/xforg/AI_SPACE/mantle-monorepo/packages/agent-core/web/src/lib/agent-core.ts`
- `/Users/xforg/AI_SPACE/mantle-monorepo/packages/agent-core/web/src/hooks/use-agent-core-app.ts`
- `/Users/xforg/AI_SPACE/mantle-monorepo/packages/agent-core/web/src/App.tsx`

# Validation

Executed successfully:

- `npm run typecheck`
- `npm run build`
- `cd web && npm run build`

# Follow-up

Recommended next steps:

1. Add a small e2e suite for `observe -> act_gui -> verify`.
2. Move verification into a dedicated abstraction in P2.
3. Revisit selective HITL once thick tools are stable in practice.
