---
title: Agent Sandbox Security
status: ready
owner: claude
created: 2026-04-13
updated: 2026-04-20
implements: []
reviews: []
---

# Agent Sandbox Security

## Motivation

Inspired by NanoClaw and ZeroClaw's isolation approaches, this spec adds
configurable security layers for agent-core tool execution. The primary
concern is preventing prompt injection attacks from escalating to
host-level damage when the agent is connected to external LLM providers.

## Security Levels

| Level | Name | Description | Use Case |
|-------|------|-------------|----------|
| 0 | None | No restrictions | Local development with trusted LLM |
| 1 | Fence | Command blocklist + path validation | Default for production / external LLM |
| 2 | Container | Docker isolation | High-security deployments |

## Level 1: Command Fence

### Default Blocked Patterns

- `rm -rf /` and variants (root filesystem deletion)
- `sudo`, `su` (privilege escalation)
- `curl | sh`, `wget | sh` (download-and-execute)
- `mkfs`, `dd of=/` (disk destructive)
- `systemctl`, `launchctl` (service manipulation)
- `nc -l` (netcat listener / reverse shell)
- Known crypto miners

### Path Validation

- **Write operations**: Only allowed within `workspaceDir` (configurable)
- **Read operations**: `workspaceDir` + optional `readOnlyPaths`
- **Execute**: Command validated before shell invocation

### Configuration

Environment variables:
```
AGENT_CORE_SANDBOX_LEVEL=1
AGENT_CORE_SANDBOX_ALLOWED_COMMANDS=node,npm,git,python
AGENT_CORE_SANDBOX_BLOCKED_PATTERNS=custom_pattern_1,custom_pattern_2
```

Or `.deepagents/settings.json`:
```json
{
  "sandbox": {
    "level": 1,
    "allowedCommands": ["node", "npm", "git", "python"],
    "networkAccess": false
  }
}
```

## Level 2: Docker Isolation (Future)

Not yet implemented. When available:
- Execute commands inside ephemeral Docker container
- Workspace mounted as volume (configurable read/write)
- Network disabled by default
- Resource limits (CPU, memory, time)

## Implementation

- `src/sandbox.ts` — `SandboxValidator` class + `createSandboxMiddleware()`
- Middleware intercepts tool calls before execution
- Blocked calls return error messages to the agent (not silent drops)
- Integrates with existing HITL — sandbox validates *before* HITL approval

## Files

- `src/sandbox.ts` — Core implementation
- `src/settings.ts` — Configuration parsing
- `src/agent.ts` — Middleware integration

## Implementation notes

Implemented today:
- `src/sandbox.ts` contains `SandboxValidator` plus `createSandboxMiddleware()`
- Level 1 command validation is implemented with default blocked patterns, optional allowlist mode, and optional network-command blocking
- Level 1 path validation is implemented for writes and for reads when `readOnlyPaths` is configured
- `src/settings.ts` parses `AGENT_CORE_SANDBOX_LEVEL`, `AGENT_CORE_SANDBOX_ALLOWED_COMMANDS`, and `AGENT_CORE_SANDBOX_BLOCKED_PATTERNS`
- `src/agent.ts` wires sandbox middleware before HITL middleware, so sandbox rejection happens before approval prompts

Not fully implemented yet:
- The `.deepagents/settings.json` sandbox configuration path described above is not currently loaded
- `networkAccess`, `allowedWritePaths`, and `readOnlyPaths` exist in the runtime types but are not exposed through `loadSettings()`
- Level 2 Docker isolation remains future work
- Read-path validation currently only runs when `readOnlyPaths` is configured, rather than always enforcing the full read fence described in the spec
