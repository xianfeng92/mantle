/**
 * HTML report generator for E2E test results.
 *
 * Reads metrics JSON, produces a standalone HTML file with:
 * - Summary cards (success rate, latency, tokens, fallback/retry)
 * - Per-test table with status, duration, token usage
 * - Expandable failure details
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestMetric } from "../test-helpers.js";

interface ReportData {
  timestamp: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    successRate: number;
    totalDurationMs: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    fallbackCount: number;
    retryCount: number;
  };
  tests: TestMetric[];
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function statusBadge(status: string): string {
  const colors: Record<string, string> = {
    pass: "#22c55e",
    fail: "#ef4444",
    skip: "#a3a3a3",
  };
  const labels: Record<string, string> = {
    pass: "PASS",
    fail: "FAIL",
    skip: "SKIP",
  };
  const color = colors[status] ?? "#a3a3a3";
  const label = labels[status] ?? status.toUpperCase();
  return `<span style="background:${color};color:#fff;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600">${label}</span>`;
}

function card(title: string, value: string, sub?: string): string {
  return `
    <div style="background:#1e1e2e;border-radius:12px;padding:20px 24px;min-width:160px;flex:1">
      <div style="color:#a0a0b0;font-size:13px;margin-bottom:6px">${escapeHtml(title)}</div>
      <div style="color:#e0e0e0;font-size:28px;font-weight:700">${value}</div>
      ${sub ? `<div style="color:#707080;font-size:12px;margin-top:4px">${escapeHtml(sub)}</div>` : ""}
    </div>`;
}

function testRow(m: TestMetric): string {
  const dur = (m.durationMs / 1000).toFixed(1);
  const prompt = m.promptTokens ?? "—";
  const completion = m.completionTokens ?? "—";
  const ctx = m.contextUsagePercent != null ? `${m.contextUsagePercent}%` : "—";
  const tools = m.toolCallCount > 0 ? String(m.toolCallCount) : "—";
  const flags: string[] = [];
  if (m.fallbackTriggered) flags.push("⚡fallback");
  if (m.retryTriggered) flags.push("🔄retry");

  // L2 quality score
  const qualityBadge = m.evalResult
    ? (() => {
        const score = m.evalResult.compositeScore;
        const color = score >= 0.8 ? "#22c55e" : score >= 0.6 ? "#eab308" : "#ef4444";
        const tooltip = m.evalResult.scores
          .map((s) => `${s.dimension}: ${s.value}`)
          .join(", ");
        return `<span title="${escapeHtml(tooltip)}" style="color:${color};font-weight:600">${score.toFixed(2)}</span>`;
      })()
    : "—";

  const errorRow = m.error
    ? `<tr><td colspan="9" style="padding:8px 16px 16px 40px;color:#f87171;font-size:13px;border-bottom:1px solid #2a2a3a">→ ${escapeHtml(m.error.slice(0, 300))}</td></tr>`
    : "";

  // Eval detail row (per-dimension breakdown)
  const evalRow = m.evalResult && m.evalResult.scores.length > 0
    ? `<tr><td colspan="9" style="padding:4px 16px 12px 40px;font-size:12px;border-bottom:1px solid #2a2a3a">${m.evalResult.scores.map((s) => {
        const c = s.passed ? "#22c55e" : "#ef4444";
        return `<span style="color:${c};margin-right:12px">${escapeHtml(s.dimension)}: ${s.value.toFixed(2)}</span>`;
      }).join("")}${m.evalResult.judgeError ? `<span style="color:#f59e0b"> ⚠ ${escapeHtml(m.evalResult.judgeError.slice(0, 100))}</span>` : ""}</td></tr>`
    : "";

  return `
    <tr style="border-bottom:1px solid #2a2a3a">
      <td style="padding:12px 16px">${statusBadge(m.status)}</td>
      <td style="padding:12px 8px;color:#e0e0e0">${escapeHtml(m.suite)}</td>
      <td style="padding:12px 8px;color:#e0e0e0">${escapeHtml(m.testName)}</td>
      <td style="padding:12px 8px;color:#a0a0b0;text-align:right">${dur}s</td>
      <td style="padding:12px 8px;color:#a0a0b0;text-align:right">${prompt}</td>
      <td style="padding:12px 8px;color:#a0a0b0;text-align:right">${completion}</td>
      <td style="padding:12px 8px;color:#a0a0b0;text-align:right">${ctx}</td>
      <td style="padding:12px 8px;color:#a0a0b0">${tools} ${flags.join(" ")}</td>
      <td style="padding:12px 8px;text-align:center">${qualityBadge}</td>
    </tr>
    ${evalRow}${errorRow}`;
}

export function generateHtml(data: ReportData): string {
  const s = data.summary;
  const avgDuration = s.total > 0 ? (s.totalDurationMs / s.total / 1000).toFixed(1) : "0";
  const successColor = s.successRate >= 90 ? "#22c55e" : s.successRate >= 70 ? "#eab308" : "#ef4444";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent-Core E2E Report — ${data.timestamp.slice(0, 10)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, "SF Pro Text", "Helvetica Neue", sans-serif; background: #0f0f1a; color: #e0e0e0; padding: 32px; }
    h1 { font-size: 24px; font-weight: 700; margin-bottom: 8px; }
    .subtitle { color: #707080; font-size: 14px; margin-bottom: 32px; }
    .cards { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 32px; }
    table { width: 100%; border-collapse: collapse; background: #1e1e2e; border-radius: 12px; overflow: hidden; }
    th { text-align: left; padding: 12px 16px; color: #707080; font-size: 12px; font-weight: 600; text-transform: uppercase; border-bottom: 1px solid #2a2a3a; }
    th:nth-child(n+4) { text-align: right; }
    th:last-child { text-align: left; }
  </style>
</head>
<body>
  <h1>Agent-Core E2E Test Report</h1>
  <div class="subtitle">Generated: ${escapeHtml(data.timestamp)} · Model: google/gemma-4-26b-a4b</div>

  <div class="cards">
    ${card("任务成功率", `<span style="color:${successColor}">${s.successRate}%</span>`, `${s.passed}/${s.total} passed`)}
    ${card("平均推理耗时", `${avgDuration}s`, `Total: ${(s.totalDurationMs / 1000).toFixed(1)}s`)}
    ${card("Token 用量", `${(s.totalPromptTokens + s.totalCompletionTokens).toLocaleString()}`, `${s.totalPromptTokens.toLocaleString()} prompt / ${s.totalCompletionTokens.toLocaleString()} completion`)}
    ${card("Fallback / Retry", `${s.fallbackCount} / ${s.retryCount}`, "Gemma 4 兼容性指标")}
    ${(() => {
      const evalTests = data.tests.filter((t) => t.evalResult);
      if (evalTests.length === 0) return "";
      const avg = evalTests.reduce((s, t) => s + (t.evalResult?.compositeScore ?? 0), 0) / evalTests.length;
      const qColor = avg >= 0.8 ? "#22c55e" : avg >= 0.6 ? "#eab308" : "#ef4444";
      return card("质量评分 (L2)", `<span style="color:${qColor}">${avg.toFixed(2)}</span>`, `${evalTests.length} tests evaluated`);
    })()}
  </div>

  <table>
    <thead>
      <tr>
        <th style="width:70px">Status</th>
        <th>Suite</th>
        <th>Test</th>
        <th style="text-align:right">Duration</th>
        <th style="text-align:right">Prompt</th>
        <th style="text-align:right">Completion</th>
        <th style="text-align:right">Ctx %</th>
        <th>Tools</th>
        <th style="text-align:center">Quality</th>
      </tr>
    </thead>
    <tbody>
      ${data.tests.map(testRow).join("\n")}
    </tbody>
  </table>

  ${(() => {
    // Dimension breakdown section
    const dimMap = new Map<string, { total: number; passed: number; sumValue: number }>();
    for (const t of data.tests) {
      if (!t.evalResult) continue;
      for (const sc of t.evalResult.scores) {
        const entry = dimMap.get(sc.dimension) ?? { total: 0, passed: 0, sumValue: 0 };
        entry.total++;
        if (sc.passed) entry.passed++;
        entry.sumValue += sc.value;
        dimMap.set(sc.dimension, entry);
      }
    }
    if (dimMap.size === 0) return "";

    const rows = [...dimMap.entries()].map(([name, d]) => {
      const avg = (d.sumValue / d.total).toFixed(2);
      const passRate = Math.round((d.passed / d.total) * 100);
      const c = passRate >= 80 ? "#22c55e" : passRate >= 60 ? "#eab308" : "#ef4444";
      return `<tr style="border-bottom:1px solid #2a2a3a">
        <td style="padding:10px 16px;color:#e0e0e0">${escapeHtml(name)}</td>
        <td style="padding:10px 8px;text-align:right;color:#a0a0b0">${d.total}</td>
        <td style="padding:10px 8px;text-align:right;color:${c}">${avg}</td>
        <td style="padding:10px 8px;text-align:right;color:${c}">${passRate}%</td>
      </tr>`;
    }).join("");

    return `
  <h2 style="font-size:18px;font-weight:600;margin-top:32px;margin-bottom:12px">维度分析 (L2 Dimensions)</h2>
  <table>
    <thead><tr>
      <th>Dimension</th>
      <th style="text-align:right">Tests</th>
      <th style="text-align:right">Avg Score</th>
      <th style="text-align:right">Pass Rate</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
  })()}

  <div style="margin-top:24px;color:#505060;font-size:12px;text-align:center">
    agent-core E2E · ${s.total} tests · ${(s.totalDurationMs / 1000).toFixed(1)}s total
  </div>
</body>
</html>`;
}

export async function writeReport(
  data: ReportData,
  outputDir = path.join(import.meta.dirname, "..", "reports"),
): Promise<string> {
  await mkdir(outputDir, { recursive: true });

  // Write per-suite JSON fragment
  const suite = data.tests[0]?.suite ?? "unknown";
  const fragmentPath = path.join(outputDir, `e2e-fragment-${suite}.json`);
  await writeFile(fragmentPath, JSON.stringify(data, null, 2), "utf-8");

  // Merge all existing fragments into one combined report
  const merged = await mergeFragments(outputDir);
  const filePath = path.join(outputDir, "e2e-report.html");
  await writeFile(filePath, generateHtml(merged), "utf-8");

  const jsonPath = path.join(outputDir, "e2e-report.json");
  await writeFile(jsonPath, JSON.stringify(merged, null, 2), "utf-8");

  return filePath;
}

async function mergeFragments(dir: string): Promise<ReportData> {
  const { readdir, readFile } = await import("node:fs/promises");
  const files = (await readdir(dir)).filter((f) => f.startsWith("e2e-fragment-") && f.endsWith(".json"));

  const allTests: TestMetric[] = [];
  let latestTimestamp = "";

  for (const f of files) {
    try {
      const raw = await readFile(path.join(dir, f), "utf-8");
      const fragment = JSON.parse(raw) as ReportData;
      allTests.push(...fragment.tests);
      if (fragment.timestamp > latestTimestamp) latestTimestamp = fragment.timestamp;
    } catch { /* skip corrupt fragments */ }
  }

  const passed = allTests.filter((t) => t.status === "pass").length;
  const failed = allTests.filter((t) => t.status === "fail").length;
  const skipped = allTests.filter((t) => t.status === "skip").length;
  const total = allTests.length;

  return {
    timestamp: latestTimestamp || new Date().toISOString(),
    summary: {
      total,
      passed,
      failed,
      skipped,
      successRate: total > 0 ? Math.round((passed / total) * 1000) / 10 : 0,
      totalDurationMs: allTests.reduce((s, t) => s + t.durationMs, 0),
      totalPromptTokens: allTests.reduce((s, t) => s + (t.promptTokens ?? 0), 0),
      totalCompletionTokens: allTests.reduce((s, t) => s + (t.completionTokens ?? 0), 0),
      fallbackCount: allTests.filter((t) => t.fallbackTriggered).length,
      retryCount: allTests.filter((t) => t.retryTriggered).length,
    },
    tests: allTests,
  };
}
