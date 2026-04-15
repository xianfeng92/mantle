export interface SmokeTaskDefinition {
  id: string;
  title: string;
  category: "backend" | "runtime" | "approval" | "memory" | "safety" | "observability";
  objective: string;
  testPatterns: RegExp[];
}

export const smokeTaskPackV1: SmokeTaskDefinition[] = [
  {
    id: "backend-health",
    title: "Backend health and metadata surface",
    category: "backend",
    objective: "Verify that local clients can discover model, prompt profile, and health metadata.",
    testPatterns: [/health/i, /model info/i],
  },
  {
    id: "thread-lifecycle",
    title: "Thread lifecycle",
    category: "runtime",
    objective: "Create, resume, and delete threads without corrupting local state.",
    testPatterns: [/thread/i, /delete thread/i, /create a thread/i],
  },
  {
    id: "hitl-review",
    title: "Approval and interrupt flow",
    category: "approval",
    objective: "Pause on sensitive tools, surface review payloads, and resume correctly after approval or rejection.",
    testPatterns: [/interrupt/i, /\bHITL\b/i, /approval/i, /reject/i, /resume/i],
  },
  {
    id: "memory-roundtrip",
    title: "Cross-session memory roundtrip",
    category: "memory",
    objective: "Store, list, inject, and clear memory entries without breaking conversation flow.",
    testPatterns: [/\bmemory\b/i],
  },
  {
    id: "diagnostics-surface",
    title: "Diagnostics and trace surface",
    category: "observability",
    objective: "Return diagnostics aggregates and trace data after representative runs.",
    testPatterns: [/diagnostics/i, /trace/i],
  },
  {
    id: "rollback-safety",
    title: "Rollback and move safety",
    category: "safety",
    objective: "Keep file move rollback and safety rails available for reversible workflows.",
    testPatterns: [/rollback/i, /\bmove\b/i],
  },
  {
    id: "context-resilience",
    title: "Context resilience",
    category: "runtime",
    objective: "Recover cleanly from fallback, retry, and context pressure conditions.",
    testPatterns: [/fallback/i, /retry/i, /context/i, /compaction/i],
  },
];

export function matchSmokeTasks(testName: string): SmokeTaskDefinition[] {
  return smokeTaskPackV1.filter((task) =>
    task.testPatterns.some((pattern) => pattern.test(testName)),
  );
}
