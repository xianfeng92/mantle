import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HumanMessage, AIMessage } from "@langchain/core/messages";

import { parseHeartbeatFile } from "../src/heartbeat/parser.js";
import { nextFireAfter, isDue } from "../src/heartbeat/scheduler.js";
import { HeartbeatEngine } from "../src/heartbeat/engine.js";
import { ReturnDispatcher, ReturnStore } from "../src/returns.js";

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

test("parser: valid frontmatter with two tasks", () => {
  const raw = `---
tasks:
  - id: morning
    schedule: "daily 07:00"
    handler: agent-run
    prompt: "hi"
  - id: weekly-review
    schedule: "weekly fri 17:00"
    handler: agent-run
    prompt: "scan the week"
    tags: [weekly]
    announce:
      channels: ["macos-notification"]
      urgency: normal
---

# Notes
Anything here is ignored.
`;
  const result = parseHeartbeatFile(raw);
  assert.deepEqual(result.errors, []);
  assert.equal(result.tasks.length, 2);
  assert.equal(result.tasks[0]!.id, "morning");
  assert.equal(result.tasks[1]!.announce?.channels[0], "macos-notification");
  assert.equal(result.tasks[1]!.enabled, true);
});

test("parser: missing frontmatter returns error", () => {
  const result = parseHeartbeatFile("# No frontmatter here\n\njust markdown");
  assert.equal(result.tasks.length, 0);
  assert.ok(result.errors[0]?.includes("No YAML frontmatter"));
});

test("parser: missing required fields reported", () => {
  const raw = `---
tasks:
  - id: broken
    schedule: "daily 07:00"
    handler: agent-run
  - schedule: "daily 08:00"
    handler: agent-run
    prompt: "no id"
---`;
  const result = parseHeartbeatFile(raw);
  assert.equal(result.tasks.length, 0);
  assert.ok(result.errors.some((e) => e.includes("empty `prompt`")));
  assert.ok(result.errors.some((e) => e.includes("`id`")));
});

test("parser: unknown handler rejected", () => {
  const raw = `---
tasks:
  - id: x
    schedule: "daily 07:00"
    handler: wat
---`;
  const result = parseHeartbeatFile(raw);
  assert.ok(result.errors[0]?.includes("handler must be one of"));
});

test("parser: duplicate id rejected", () => {
  const raw = `---
tasks:
  - id: same
    schedule: "daily 07:00"
    handler: agent-run
    prompt: "a"
  - id: same
    schedule: "daily 08:00"
    handler: agent-run
    prompt: "b"
---`;
  const result = parseHeartbeatFile(raw);
  assert.equal(result.tasks.length, 1);
  assert.ok(result.errors.some((e) => e.includes("duplicate id")));
});

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

test("scheduler: daily — next fire is today if slot still ahead", () => {
  const now = new Date("2026-04-16T06:00:00");
  const next = nextFireAfter("daily 07:00", undefined, now);
  assert.ok(next);
  assert.equal(next!.getHours(), 7);
  assert.equal(next!.getDate(), 16);
});

test("scheduler: daily — rolls to tomorrow if slot already passed", () => {
  const now = new Date("2026-04-16T08:00:00");
  const next = nextFireAfter("daily 07:00", undefined, now);
  assert.equal(next!.getDate(), 17);
});

test("scheduler: daily — never before lastFiredAt", () => {
  const now = new Date("2026-04-16T08:00:00");
  const lastFired = new Date("2026-04-16T07:00:02");
  const next = nextFireAfter("daily 07:00", lastFired, now);
  assert.equal(next!.getDate(), 17);
});

test("scheduler: every N minutes — returns now if never fired", () => {
  const now = new Date("2026-04-16T08:00:00");
  const next = nextFireAfter("every 10 minutes", undefined, now);
  assert.equal(next!.getTime(), now.getTime());
});

test("scheduler: every N minutes — advances by interval from lastFiredAt", () => {
  const now = new Date("2026-04-16T08:15:00");
  const lastFired = new Date("2026-04-16T08:00:00");
  const next = nextFireAfter("every 10 minutes", lastFired, now);
  assert.equal(next!.getTime() - lastFired.getTime(), 10 * 60_000);
});

test("scheduler: weekly — rolls to next occurrence of weekday", () => {
  // 2026-04-16 is a Thursday (day 4). Weekly Fri (5) → next day.
  const now = new Date("2026-04-16T10:00:00");
  const next = nextFireAfter("weekly fri 17:00", undefined, now);
  assert.equal(next!.getDay(), 5);
  assert.equal(next!.getDate(), 17);
});

test("scheduler: isDue — disabled task never due", () => {
  const now = new Date("2026-04-16T07:00:01");
  const { due } = isDue(
    { id: "x", schedule: "daily 07:00", handler: "agent-run", enabled: false },
    undefined,
    now,
  );
  assert.equal(due, false);
});

test("scheduler: isDue — fires exactly when slot hits", () => {
  const now = new Date("2026-04-16T07:00:01");
  const { due } = isDue(
    { id: "x", schedule: "daily 07:00", handler: "agent-run" },
    undefined,
    now,
  );
  assert.equal(due, true);
});

test("scheduler: malformed schedule returns undefined", () => {
  assert.equal(nextFireAfter("nonsense", undefined, new Date()), undefined);
  assert.equal(nextFireAfter("daily 25:99", undefined, new Date()), undefined);
});

// ---------------------------------------------------------------------------
// Engine smoke (with fake service)
// ---------------------------------------------------------------------------

test("engine: runNow fires handler, dispatches ReturnDraft, persists state", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-core-heartbeat-"));
  try {
    const dataDir = path.join(tempDir, "data");
    await mkdir(dataDir, { recursive: true });
    const heartbeatFile = path.join(tempDir, "HEARTBEAT.md");
    const statePath = path.join(dataDir, "heartbeat-state.json");

    await writeFile(
      heartbeatFile,
      `---
tasks:
  - id: smoke-one
    schedule: "every 1 minutes"
    handler: agent-run
    prompt: "say hi"
    tags: [test]
---
`,
      "utf-8",
    );

    const runOnceCalls: Array<{ threadId: string; input: unknown }> = [];
    const fakeService = {
      async runOnce(options: { threadId: string; input: unknown; traceId?: string }) {
        runOnceCalls.push({ threadId: options.threadId, input: options.input });
        return {
          traceId: options.traceId ?? "trace",
          status: "completed" as const,
          threadId: options.threadId,
          interruptCount: 0,
          messages: [
            new HumanMessage("say hi"),
            new AIMessage("hello there"),
          ],
          newMessages: [new AIMessage("hello there")],
        };
      },
    };

    const returnStore = new ReturnStore(path.join(dataDir, "returns.jsonl"));
    const dispatcher = new ReturnDispatcher(returnStore);

    const engine = new HeartbeatEngine({
      heartbeatFilePath: heartbeatFile,
      statePath,
      // Cast the fake — only runOnce is reached by the agent-run handler.
      service: fakeService as unknown as import("../src/service.js").AgentCoreServiceHarness,
      returnDispatcher: dispatcher,
      tickIntervalSec: 999, // tick won't fire during the test
    });

    await engine.start();
    const state = await engine.runNow("smoke-one");

    assert.equal(state.lastStatus, "ok");
    assert.ok(state.lastReturnId);
    assert.equal(runOnceCalls.length, 1);
    assert.ok(runOnceCalls[0]!.threadId.startsWith("heartbeat:smoke-one:"));

    const stored = await returnStore.list();
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.kind, "heartbeat.agent-run");
    assert.equal(stored[0]!.title, "smoke-one");
    assert.equal(stored[0]!.summary, "hello there");
    assert.ok(stored[0]!.tags.includes("test"));

    // State persisted to disk
    const rawState = await readFile(statePath, "utf-8");
    assert.ok(rawState.includes("smoke-one"));
    assert.ok(rawState.includes("\"lastStatus\": \"ok\""));

    engine.stop();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("engine: runNow on missing task throws", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-core-heartbeat-"));
  try {
    const heartbeatFile = path.join(tempDir, "HEARTBEAT.md");
    await writeFile(heartbeatFile, "---\ntasks: []\n---\n", "utf-8");

    const engine = new HeartbeatEngine({
      heartbeatFilePath: heartbeatFile,
      statePath: path.join(tempDir, "state.json"),
      service: {} as import("../src/service.js").AgentCoreServiceHarness,
      returnDispatcher: new ReturnDispatcher(
        new ReturnStore(path.join(tempDir, "returns.jsonl")),
      ),
      tickIntervalSec: 999,
    });
    await engine.start();

    await assert.rejects(() => engine.runNow("nope"), /not found/);
    engine.stop();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("engine: listStatus reports nextFireAt from state", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-core-heartbeat-"));
  try {
    const heartbeatFile = path.join(tempDir, "HEARTBEAT.md");
    await writeFile(
      heartbeatFile,
      `---
tasks:
  - id: hourly
    schedule: "every 60 minutes"
    handler: agent-run
    prompt: "x"
---
`,
      "utf-8",
    );
    const statePath = path.join(tempDir, "state.json");
    await writeFile(
      statePath,
      JSON.stringify({
        tasks: {
          hourly: { lastFiredAt: "2026-04-16T08:00:00.000Z", lastStatus: "ok" },
        },
      }),
      "utf-8",
    );

    const engine = new HeartbeatEngine({
      heartbeatFilePath: heartbeatFile,
      statePath,
      service: {} as import("../src/service.js").AgentCoreServiceHarness,
      returnDispatcher: new ReturnDispatcher(
        new ReturnStore(path.join(tempDir, "returns.jsonl")),
      ),
      tickIntervalSec: 999,
      now: () => new Date("2026-04-16T08:15:00.000Z"),
    });
    await engine.start();

    const statuses = engine.listStatus();
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0]!.def.id, "hourly");
    // Next fire is lastFiredAt + 60 min = 09:00.
    assert.equal(statuses[0]!.nextFireAt, "2026-04-16T09:00:00.000Z");
    assert.equal(statuses[0]!.state.lastStatus, "ok");

    engine.stop();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
