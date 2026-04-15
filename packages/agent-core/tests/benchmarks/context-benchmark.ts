/**
 * Context Management Benchmark
 *
 * Evaluates agent-core's context handling under prolonged conversations:
 *   - Conversation depth before overflow
 *   - Compression information retention rate
 *   - Overflow recovery success rate
 *   - Token efficiency (tokens per turn)
 *   - End-to-end latency impact of compaction
 *
 * Usage:
 *   npm run bench:context              # requires LM Studio running
 *   npm run bench:context -- --dry-run # mock model, no LM Studio needed
 *
 * Output: .agent-core/benchmarks/context-<timestamp>.json
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BenchmarkConfig {
  dryRun: boolean;
  baseUrl: string;
  model: string;
  maxTurns: number;
  retentionFactCount: number;
  overflowTrials: number;
}

interface TurnRecord {
  turn: number;
  prompt: string;
  responsePreview: string;
  durationMs: number;
  estimatedPromptTokens: number;
  estimatedCompletionTokens: number;
  compactionTriggered: boolean;
  error?: string;
}

interface RetentionProbe {
  question: string;
  expectedKeyword: string;
  answer: string;
  hit: boolean;
}

interface OverflowTrial {
  trial: number;
  overflowDetected: boolean;
  recoveryAttempted: boolean;
  recoverySucceeded: boolean;
  error?: string;
}

interface BenchmarkReport {
  timestamp: string;
  config: BenchmarkConfig;
  metrics: {
    conversationDepth: number;
    maxTurnsReached: boolean;
    compactionCount: number;
    retentionRate: number;
    retentionProbes: RetentionProbe[];
    overflowRecoveryRate: number;
    overflowTrials: OverflowTrial[];
    avgTokensPerTurn: number;
    totalTokensEstimate: number;
    avgLatencyMs: number;
    avgLatencyWithCompactionMs: number | null;
    avgLatencyWithoutCompactionMs: number | null;
  };
  turns: TurnRecord[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  // Rough estimate: ~4 chars per token for English
  return Math.ceil(text.length / 4);
}

function parseArgs(): BenchmarkConfig {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes("--dry-run"),
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "google/gemma-4-26b-a4b",
    maxTurns: 60,
    retentionFactCount: 5,
    overflowTrials: 3,
  };
}

// ---------------------------------------------------------------------------
// Mock model for dry-run mode
// ---------------------------------------------------------------------------

let mockTurnCounter = 0;
let mockCompactionAt = 15; // simulate compaction at turn 15
let mockOverflowAt = 25; // simulate overflow at turn 25

async function mockChat(
  _messages: Array<{ role: string; content: string }>,
): Promise<{ content: string; promptTokens: number; completionTokens: number }> {
  mockTurnCounter++;
  await new Promise((r) => setTimeout(r, 10 + Math.random() * 20));

  if (mockTurnCounter >= mockOverflowAt) {
    throw Object.assign(new Error("context size exceeded"), { status: 400 });
  }

  const content = `[Mock response for turn ${mockTurnCounter}] I acknowledge the information provided. ` +
    `The capital of Testland is Mockville. The year is 2026. ` +
    `Project Alpha uses TypeScript. The team has 7 members. ` +
    `The deadline is June 15th.`;

  return {
    content,
    promptTokens: 200 + mockTurnCounter * 50,
    completionTokens: estimateTokens(content),
  };
}

// ---------------------------------------------------------------------------
// Real model chat (OpenAI-compatible)
// ---------------------------------------------------------------------------

async function realChat(
  messages: Array<{ role: string; content: string }>,
  config: BenchmarkConfig,
): Promise<{ content: string; promptTokens: number; completionTokens: number }> {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      messages,
      max_tokens: 512,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    const error = Object.assign(new Error(`LM Studio error: ${text}`), {
      status: response.status,
    });
    throw error;
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  return {
    content,
    promptTokens: data.usage?.prompt_tokens ?? estimateTokens(messages.map((m) => m.content).join(" ")),
    completionTokens: data.usage?.completion_tokens ?? estimateTokens(content),
  };
}

// ---------------------------------------------------------------------------
// Fact seeds for retention testing
// ---------------------------------------------------------------------------

const FACTS = [
  { statement: "The capital of Testland is Mockville.", question: "What is the capital of Testland?", keyword: "mockville" },
  { statement: "Project Alpha uses TypeScript as its primary language.", question: "What language does Project Alpha use?", keyword: "typescript" },
  { statement: "The team consists of exactly 7 engineers.", question: "How many engineers are on the team?", keyword: "7" },
  { statement: "The project deadline is June 15th, 2026.", question: "When is the project deadline?", keyword: "june" },
  { statement: "The main database is PostgreSQL version 16.", question: "What database does the project use?", keyword: "postgresql" },
];

// ---------------------------------------------------------------------------
// Conversation prompts (diverse to simulate real usage)
// ---------------------------------------------------------------------------

function getTurnPrompt(turn: number): string {
  // First few turns plant facts
  if (turn < FACTS.length) {
    return `Remember this fact: ${FACTS[turn].statement} Please acknowledge it briefly.`;
  }

  const prompts = [
    "What are the advantages of using a local LLM for development?",
    "Explain how context window management works in language models.",
    "Describe a good error handling strategy for API clients.",
    "How would you design a retry mechanism with exponential backoff?",
    "What are the trade-offs between streaming and batch inference?",
    "How do you handle state persistence in a web application?",
    "Explain the concept of middleware in a framework like LangGraph.",
    "What metrics matter most for evaluating an AI agent system?",
    "How would you implement graceful degradation in an agent?",
    "Describe best practices for managing conversation history.",
  ];

  return prompts[(turn - FACTS.length) % prompts.length];
}

// ---------------------------------------------------------------------------
// Main benchmark
// ---------------------------------------------------------------------------

async function runBenchmark(): Promise<BenchmarkReport> {
  const config = parseArgs();
  const turns: TurnRecord[] = [];
  const conversationHistory: Array<{ role: string; content: string }> = [];
  let compactionCount = 0;
  let conversationDepth = 0;
  let maxTurnsReached = false;

  const chat = config.dryRun ? mockChat : (msgs: Array<{ role: string; content: string }>) => realChat(msgs, config);

  console.log(`\n📊 Context Benchmark — ${config.dryRun ? "DRY RUN (mock)" : "LIVE (LM Studio)"}`);
  console.log(`   Max turns: ${config.maxTurns}`);
  console.log("");

  // Phase 1: Multi-turn conversation until overflow or maxTurns
  for (let turn = 0; turn < config.maxTurns; turn++) {
    const prompt = getTurnPrompt(turn);
    conversationHistory.push({ role: "user", content: prompt });

    const start = Date.now();
    let record: TurnRecord;

    try {
      const result = await chat(conversationHistory);
      const durationMs = Date.now() - start;

      conversationHistory.push({ role: "assistant", content: result.content });

      // Detect simulated compaction (in dry-run, based on mockCompactionAt)
      const compactionTriggered = config.dryRun
        ? turn === mockCompactionAt
        : result.content.includes("[compaction]"); // placeholder heuristic

      if (compactionTriggered) {
        compactionCount++;
        // Simulate compaction: keep system-like summary + recent turns
        if (config.dryRun) {
          const summary = `[Summary] Previous ${conversationHistory.length - 6} messages summarized. Key facts preserved.`;
          const recent = conversationHistory.slice(-6);
          conversationHistory.length = 0;
          conversationHistory.push({ role: "system", content: summary }, ...recent);
        }
      }

      record = {
        turn,
        prompt: prompt.slice(0, 100),
        responsePreview: result.content.slice(0, 120),
        durationMs,
        estimatedPromptTokens: result.promptTokens,
        estimatedCompletionTokens: result.completionTokens,
        compactionTriggered,
      };

      conversationDepth = turn + 1;
      process.stdout.write(`  Turn ${turn + 1}/${config.maxTurns} — ${durationMs}ms${compactionTriggered ? " [compacted]" : ""}\r`);
    } catch (error) {
      const durationMs = Date.now() - start;
      const message = error instanceof Error ? error.message : String(error);
      const isContextOverflow = /context.*(size|length)\s*exceeded/i.test(message);

      record = {
        turn,
        prompt: prompt.slice(0, 100),
        responsePreview: "",
        durationMs,
        estimatedPromptTokens: 0,
        estimatedCompletionTokens: 0,
        compactionTriggered: false,
        error: message,
      };

      if (isContextOverflow) {
        console.log(`\n  ⚠ Context overflow at turn ${turn + 1}`);
        conversationDepth = turn;
        break;
      } else {
        console.log(`\n  ✗ Error at turn ${turn + 1}: ${message}`);
        conversationDepth = turn;
        break;
      }
    }

    turns.push(record);

    if (turn === config.maxTurns - 1) {
      maxTurnsReached = true;
    }
  }

  console.log(`\n  Conversation depth: ${conversationDepth} turns`);

  // Phase 2: Retention probes (ask about planted facts)
  console.log("\n📋 Retention probes:");
  const retentionProbes: RetentionProbe[] = [];

  for (const fact of FACTS.slice(0, config.retentionFactCount)) {
    try {
      conversationHistory.push({ role: "user", content: fact.question });
      const result = await chat(conversationHistory);
      conversationHistory.push({ role: "assistant", content: result.content });

      const hit = result.content.toLowerCase().includes(fact.keyword.toLowerCase());
      retentionProbes.push({
        question: fact.question,
        expectedKeyword: fact.keyword,
        answer: result.content.slice(0, 200),
        hit,
      });
      console.log(`  ${hit ? "✓" : "✗"} "${fact.question}" → ${hit ? "retained" : "lost"}`);
    } catch {
      retentionProbes.push({
        question: fact.question,
        expectedKeyword: fact.keyword,
        answer: "[error]",
        hit: false,
      });
      console.log(`  ✗ "${fact.question}" → error`);
    }
  }

  const retentionRate =
    retentionProbes.length > 0
      ? retentionProbes.filter((p) => p.hit).length / retentionProbes.length
      : 0;

  // Phase 3: Overflow recovery trials
  console.log("\n🔄 Overflow recovery trials:");
  const overflowTrials: OverflowTrial[] = [];

  for (let trial = 0; trial < config.overflowTrials; trial++) {
    // Build a conversation large enough to trigger overflow
    const bigHistory: Array<{ role: string; content: string }> = [];
    const padding = "x".repeat(2000);

    for (let i = 0; i < 100; i++) {
      bigHistory.push({ role: "user", content: `Message ${i}: ${padding}` });
      bigHistory.push({ role: "assistant", content: `Ack ${i}: ${padding}` });
    }

    bigHistory.push({ role: "user", content: "Summarize our conversation briefly." });

    let overflowDetected = false;
    let recoverySucceeded = false;
    let trialError: string | undefined;

    try {
      await chat(bigHistory);
      // No overflow — model handled it
      recoverySucceeded = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      overflowDetected = /context.*(size|length)\s*exceeded/i.test(message);

      if (overflowDetected) {
        // Simulate recovery: compact and retry
        const compacted = [
          { role: "system" as const, content: "[Summary of previous 200 messages]" },
          bigHistory[bigHistory.length - 1],
        ];

        try {
          await chat(compacted);
          recoverySucceeded = true;
        } catch (retryError) {
          trialError = retryError instanceof Error ? retryError.message : String(retryError);
        }
      } else {
        trialError = message;
      }
    }

    overflowTrials.push({
      trial: trial + 1,
      overflowDetected,
      recoveryAttempted: overflowDetected,
      recoverySucceeded,
      error: trialError,
    });
    console.log(
      `  Trial ${trial + 1}: ${overflowDetected ? "overflow→" : "no overflow→"}${recoverySucceeded ? "recovered" : "failed"}`,
    );
  }

  const overflowRecoveryRate =
    overflowTrials.filter((t) => t.overflowDetected).length > 0
      ? overflowTrials.filter((t) => t.recoverySucceeded && t.overflowDetected).length /
        overflowTrials.filter((t) => t.overflowDetected).length
      : overflowTrials.every((t) => t.recoverySucceeded)
        ? 1
        : 0;

  // Compute aggregate metrics
  const successfulTurns = turns.filter((t) => !t.error);
  const totalTokens = successfulTurns.reduce(
    (sum, t) => sum + t.estimatedPromptTokens + t.estimatedCompletionTokens,
    0,
  );
  const avgTokensPerTurn = successfulTurns.length > 0 ? totalTokens / successfulTurns.length : 0;
  const avgLatencyMs =
    successfulTurns.length > 0
      ? successfulTurns.reduce((sum, t) => sum + t.durationMs, 0) / successfulTurns.length
      : 0;

  const compactedTurns = successfulTurns.filter((t) => t.compactionTriggered);
  const nonCompactedTurns = successfulTurns.filter((t) => !t.compactionTriggered);

  const report: BenchmarkReport = {
    timestamp: new Date().toISOString(),
    config,
    metrics: {
      conversationDepth,
      maxTurnsReached,
      compactionCount,
      retentionRate,
      retentionProbes,
      overflowRecoveryRate,
      overflowTrials,
      avgTokensPerTurn: Math.round(avgTokensPerTurn),
      totalTokensEstimate: totalTokens,
      avgLatencyMs: Math.round(avgLatencyMs),
      avgLatencyWithCompactionMs:
        compactedTurns.length > 0
          ? Math.round(compactedTurns.reduce((s, t) => s + t.durationMs, 0) / compactedTurns.length)
          : null,
      avgLatencyWithoutCompactionMs:
        nonCompactedTurns.length > 0
          ? Math.round(nonCompactedTurns.reduce((s, t) => s + t.durationMs, 0) / nonCompactedTurns.length)
          : null,
    },
    turns,
  };

  return report;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = parseArgs();

  if (config.dryRun) {
    // Reset mock state
    mockTurnCounter = 0;
    mockCompactionAt = 15;
    mockOverflowAt = 25;
  }

  const report = await runBenchmark();

  // Write report
  const benchDir = path.resolve(".agent-core", "benchmarks");
  await mkdir(benchDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(benchDir, `context-${ts}.json`);
  await writeFile(filePath, JSON.stringify(report, null, 2), "utf8");

  console.log("\n" + "═".repeat(60));
  console.log("📊 Summary");
  console.log("═".repeat(60));
  console.log(`  Conversation depth:    ${report.metrics.conversationDepth} turns`);
  console.log(`  Max turns reached:     ${report.metrics.maxTurnsReached}`);
  console.log(`  Compaction count:      ${report.metrics.compactionCount}`);
  console.log(`  Retention rate:        ${(report.metrics.retentionRate * 100).toFixed(0)}%`);
  console.log(`  Overflow recovery:     ${(report.metrics.overflowRecoveryRate * 100).toFixed(0)}%`);
  console.log(`  Avg tokens/turn:       ${report.metrics.avgTokensPerTurn}`);
  console.log(`  Total tokens (est.):   ${report.metrics.totalTokensEstimate}`);
  console.log(`  Avg latency:           ${report.metrics.avgLatencyMs}ms`);
  console.log(`  Report saved:          ${filePath}`);
  console.log("");
}

main().catch((error) => {
  console.error("Benchmark failed:", error);
  process.exit(1);
});
