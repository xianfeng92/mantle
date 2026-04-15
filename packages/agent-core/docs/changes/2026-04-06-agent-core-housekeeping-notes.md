---
title: Agent Core Housekeeping Notes
status: implemented
owner: claude
created: 2026-04-06
updated: 2026-04-06
implements: []
reviews: []
---

# Agent Core Housekeeping Notes

## TypeScript Version Mismatch

Root `package.json` uses `typescript@^6.0.2`, while `web/package.json` pins `typescript@~5.9.3`.

This is intentional:
- The web project is a Vite + React app with its own `tsconfig.json`
- Vite 8 and its ecosystem plugins haven't fully updated for TypeScript 6 yet
- The version ranges don't conflict at runtime since each project compiles independently
- Both `npm run typecheck` (root) and `cd web && npm run typecheck` pass cleanly

Future: unify when Vite/eslint ecosystem fully supports TypeScript 6.

## .gitignore Update

Added `agent-core/web/node_modules/` to root `.gitignore`. Previously only `agent-core/node_modules/` was excluded.

## Spec Status Update

Updated `docs/specs/2026-04-05-agent-core-design-spec.md` from `status: ready` to `status: implemented` to reflect the completed TypeScript implementation.
