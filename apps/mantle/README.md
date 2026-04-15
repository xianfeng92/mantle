# Mantle

Native macOS app (Swift + SwiftUI) that serves as a desktop-first local AI assistant powered by [`agent-core`](../../packages/agent-core) and a local model runtime such as LM Studio.

## Features

- **Menu bar resident** — always accessible from the menu bar
- **Full window mode** — expand to a full chat window with thread management
- **SSE streaming** — real-time streaming responses from agent-core
- **HITL approval** — approve/reject/edit tool calls (write_file, edit_file, execute)
- **Multi-thread** — manage multiple conversation threads

## Requirements

- macOS 14+ (Sonoma)
- Xcode 16+ (for full development experience with tests and Previews)
- [`agent-core`](../../packages/agent-core) backend running at `http://127.0.0.1:8787`
- [LM Studio](https://lmstudio.ai) with Gemma 4 at `http://127.0.0.1:1234`

## Quick Start

### 1. Start the backend

```bash
cd ../../packages/agent-core
npm run serve
```

### 2. Build & run

**Option A: Xcode (recommended)**
```bash
open Mantle.xcodeproj
# ⌘R to run
```

**Option B: Command line**
```bash
xcodebuild -scheme Mantle -configuration Debug build
```

### 3. Use

- Click the Mantle menu bar icon
- Type a message and press Enter
- Watch the streaming response from Gemma 4

## Project Structure

```text
apps/mantle/
├── Mantle/                  # App source
├── Mantle.xcodeproj/        # Xcode project
├── MantleTests/             # XCTest suite
├── docs/                    # Specs / changes / reviews
├── extras/                  # Bookmarklet and install helpers
└── scripts/                 # Local helper scripts
```

## Architecture

```
Views (SwiftUI) ← @Observable → ViewModels ← async/await → Services → agent-core HTTP API
```

- **SSE streaming** via `URLSession.bytes(for:)` — no third-party dependencies
- **MVVM** with Swift `@Observable`
- **Structured concurrency** (async/await, AsyncStream, Task)

## Development Phases

| Phase | Status | Description |
|-------|--------|-------------|
| 1. Desktop shell | ✅ | Menu bar chat, window shell, SSE streaming |
| 2. Native integration | ✅ | Permissions, desktop control, launch agents |
| 3. Ambient workflows | 🚧 | Twitter bookmark digest, Spotlight recall |
| 4. Open source polish | 🚧 | Packaging, docs, contributor UX |

## Testing

Tests require Xcode (XCTest framework):

```bash
xcodebuild test -scheme Mantle -destination 'platform=macOS'
```

## Configuration

Settings are stored in `UserDefaults`:

- **Backend URL**: `http://127.0.0.1:8787` (configurable in Settings)
- **Thread history**: persisted locally
