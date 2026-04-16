// MARK: Surface abstraction
//
// A Surface is a named entry point into agent-core. Each surface declares its
// concurrency and interruption semantics so the service harness can enforce
// them server-side.
//
// This file is pure types + a registration table — no runtime logic.
// Add new surfaces here BEFORE implementing a new entry point, then update
// the Context Assembly Contract (docs/specs/2026-04-16-context-assembly-contract-spec.md).

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SurfaceKind =
  | "chat"      // menu-bar popover / main window chat
  | "hotkey"    // global hotkey quick-ask (future)
  | "heartbeat" // heartbeat engine headless tasks
  | "cli"       // CLI REPL
  | "webhook"   // HTTP /webhook (future)
  | "digest";   // twitter-digest and similar fire-and-forget calls

export interface SurfaceDeclaration {
  kind: SurfaceKind;
  /** Whether the surface typically opens a streaming SSE connection. */
  streaming: boolean;
  /** Whether same-scope requests should abort the previous one. */
  interruptable: boolean;
  /**
   * Template for building the scope key from request parameters.
   * Placeholders use `{field}` syntax. Example: `"chat:{threadId}"`.
   *
   * Requests with the same resolved scope key are treated as "same scope":
   * if `interruptable` is true, the newer request aborts the older one.
   * Cross-scope requests always run independently.
   */
  scopeKeyTemplate: string;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const SURFACE_REGISTRY: Record<SurfaceKind, SurfaceDeclaration> = {
  chat: {
    kind: "chat",
    streaming: true,
    interruptable: true,
    scopeKeyTemplate: "chat:{threadId}",
  },
  hotkey: {
    kind: "hotkey",
    streaming: true,
    interruptable: true,
    scopeKeyTemplate: "hotkey:quick-ask",
  },
  heartbeat: {
    kind: "heartbeat",
    streaming: false,
    interruptable: false,
    scopeKeyTemplate: "heartbeat:{taskId}",
  },
  cli: {
    kind: "cli",
    streaming: false,
    interruptable: false,
    scopeKeyTemplate: "cli:{threadId}",
  },
  webhook: {
    kind: "webhook",
    streaming: false,
    interruptable: false,
    scopeKeyTemplate: "webhook:{requestId}",
  },
  digest: {
    kind: "digest",
    streaming: false,
    interruptable: false,
    scopeKeyTemplate: "digest:{requestId}",
  },
};

/**
 * Build a concrete scope key from a template and parameters.
 *
 * ```ts
 * buildScopeKey("chat:{threadId}", { threadId: "abc-123" })
 * // → "chat:abc-123"
 * ```
 */
export function buildScopeKey(
  template: string,
  params: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => params[key] ?? key);
}
