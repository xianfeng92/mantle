---
title: Gemma workspace mode and interaction entry points
date: 2026-04-12
---

# Summary

Improved Gemma 32K usability in two areas:

- added dynamic workspace mode selection for the startup preset
- improved the Web UI entry points for coding, docs, diagnostics, and desktop-lite usage

# Workspace mode

Updated the Gemma preset startup flow so it can run against:

- `repo` mode: `agent-core/`
- `workspace` mode: `/Users/xforg/AI_SPACE`
- `custom` mode: any explicit path

Changes:

- `.env.gemma-4-32k` now defaults to `AGENT_CORE_WORKSPACE_MODE=repo`
- `scripts/start-gemma-4-32k.sh` now accepts:
  - `serve|cli`
  - `repo|workspace|/custom/path`
- new npm shortcuts:
  - `serve:gemma-32k:workspace`
  - `dev:gemma-32k:workspace`

The runtime health payload now exposes:

- `workspaceDir`
- `workspaceMode`
- `virtualMode`

# Web interaction entry points

Updated the Web UI to reduce blank-slate usage and make Gemma's strongest flows easier to start:

- backend panel now shows workspace mode, workspace path, prompt profile, and context size
- empty state now offers grouped starter prompts for:
  - coding
  - docs
  - diagnostics
  - desktop-lite
- assistant-ui suggestion prompts were updated to match the same focused workflows

# Validation

Executed successfully:

- `bash -n scripts/start-gemma-4-32k.sh`
- `npm run typecheck`
- `cd web && npm run build`
- launched `bash scripts/start-gemma-4-32k.sh serve workspace` and confirmed:
  - `workspace_mode=workspace`
  - `workspace=/Users/xforg/AI_SPACE`

