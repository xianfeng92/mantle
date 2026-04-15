# Gemma 32K Startup Config

## Summary

- Added a checked-in Gemma 4 26B 32K preset at `agent-core/.env.gemma-4-32k`.
- Added `agent-core/scripts/start-gemma-4-32k.sh` to launch HTTP service or CLI with the preset.
- Added convenience scripts:
  - `npm run serve:gemma-32k`
  - `npm run dev:gemma-32k`
- Documented the preset and recommended defaults in `agent-core/README.md`.

## Preset Rationale

- `AGENT_CORE_PROMPT_PROFILE=compact`
  Keeps system prompt and tool descriptions shorter for Gemma.
- `AGENT_CORE_CONTEXT_WINDOW_TOKENS_HINT=28000`
  Matches a ~32K LM Studio load while leaving headroom for tool schemas and output.
- `AGENT_CORE_TEMPERATURE=0`
  Improves tool-call determinism and reduces formatting drift.
- `AGENT_CORE_LOG_LEVEL=info`
  Keeps the service readable during normal use.

## Notes

- The startup script loads `.env.gemma-4-32k` only as a preset. Explicitly exported environment variables still win.
- The preset targets the `agent-core` repo workspace by default. Override `AGENT_CORE_WORKSPACE_DIR` if you want the runtime to operate on a broader workspace.
