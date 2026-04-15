# Mantle

Mantle is a desktop-first, local AI agent stack for macOS.

This repository combines:

- `apps/mantle`: a native macOS client built with SwiftUI
- `packages/agent-core`: a local agent runtime built for tools, orchestration, and HTTP/SSE serving

Together they form a system where a desktop app can talk to a local agent backend, call tools, manage threads, and use native OS capabilities such as hotkeys, notifications, text selection, and desktop control.

## Why This Exists

Most AI products start in the browser. Mantle starts from the desktop.

The core idea is simple:

- the best local agent should feel like a native app, not a chat tab
- the desktop client should own UX, permissions, and system integration
- the agent runtime should stay modular, scriptable, and reusable

That split is why this repo is a monorepo, but not a monolith.

## What's Inside

### `apps/mantle`

Native macOS client for:

- menu bar and windowed chat
- global hotkeys
- notifications
- text selection flows
- Spotlight-oriented recall
- desktop control bridges
- ambient workflows such as bookmark digestion

### `packages/agent-core`

Local agent runtime for:

- model integration
- tool execution
- run checkpoints, compare, and restore
- multi-step agent loops
- HITL interrupts and resumes
- HTTP / SSE APIs
- CLI and web entry points

Each part can be worked on independently. Together they make up the full product.

## Architecture

```text
User
  -> Mantle (macOS app)
  -> agent-core (local runtime)
  -> local model provider / tools / desktop bridges
```

`Mantle` talks to `agent-core` over local HTTP/SSE. `agent-core` can also run by itself for CLI or web-based workflows.

## Quick Start

### 1. Start `agent-core`

```bash
cd packages/agent-core
npm install
cp .env.example .env
npm run serve
```

Before wiring the UI, sanity-check the local runtime:

```bash
curl http://127.0.0.1:8787/doctor
```

### 2. Launch `Mantle`

```bash
cd apps/mantle
open Mantle.xcodeproj
```

In the default monorepo layout, `Mantle` will try to discover `packages/agent-core` automatically.

## Repo Layout

```text
.
├── apps/
│   └── mantle/
├── packages/
│   └── agent-core/
└── docs/
```

## Open Source Status

This repository is actively evolving and currently serves as the unified open source home for the Mantle desktop client and the agent-core runtime.

Current state:

- monorepo structure is in place
- `Apache-2.0` license is in place
- contribution and security docs are in place
- project-specific READMEs still provide deeper setup details

Still planned:

- public-facing screenshots and GIFs
- architecture diagrams
- cleaner first-run setup
- broader test and release automation

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup and PR expectations.

If you want to work on a specific area, these are especially helpful:

- `apps/mantle` for native macOS UX and desktop integration
- `packages/agent-core` for runtime, tool execution, and model orchestration

## Security

See [SECURITY.md](./SECURITY.md).

This project includes local agent execution, desktop permissions, and localhost bridges, so responsible disclosure is appreciated.

## License

Apache-2.0. See [LICENSE](./LICENSE).
