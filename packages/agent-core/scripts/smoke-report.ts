/**
 * Smoke test runner with structured report output.
 *
 * Runs all tests via Node.js test runner, captures results, and writes
 * a JSON report to .agent-core/reports/smoke-<timestamp>.json.
 *
 * Usage:
 *   npm run smoke          # run smoke tests + generate report
 *   npm run smoke -- --ci  # non-zero exit on failure (for CI)
 */

import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

interface TestResult {
  name: string;
  status: "pass" | "fail" | "skip";
  durationMs: number;
  error?: string;
}

interface SmokeReport {
  timestamp: string;
  durationMs: number;
  summary: {
    total: number;
    pass: number;
    fail: number;
    skip: number;
  };
  iterations: Record<string, {
    total: number;
    pass: number;
    fail: number;
    tests: TestResult[];
  }>;
  allTests: TestResult[];
}

function classifyIteration(name: string): string {
  if (name.startsWith("Iteration 1:")) return "1-fallback";
  if (name.startsWith("Iteration 2:")) return "2-retry";
  if (name.startsWith("Iteration 3:")) return "3-context";
  if (name.startsWith("Iteration 4:")) return "4-persistence";
  if (name.startsWith("Iteration 5:")) return "5-cleanup";
  if (name.startsWith("Iteration 6:")) return "6-diagnostics";
  return "other";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const ciMode = args.includes("--ci");
  const startedAt = Date.now();

  // Run tests with JSON reporter via node's test runner
  const child = spawn(
    process.execPath,
    [
      "--import", "tsx",
      "--test",
      "--test-reporter", "spec",
      "--test-reporter-destination", "stderr",
      "--test-reporter", "tap",
      "--test-reporter-destination", "stdout",
      "tests/**/*.test.ts",
    ],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "inherit"],
      shell: true,
    },
  );

  let tapOutput = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    tapOutput += chunk.toString();
  });

  const exitCode = await new Promise<number>((resolve) => {
    child.on("close", (code) => resolve(code ?? 1));
  });

  const durationMs = Date.now() - startedAt;

  // Parse TAP output
  const allTests: TestResult[] = [];
  const lines = tapOutput.split("\n");

  for (const line of lines) {
    const passMatch = line.match(/^ok \d+ - (.+?)(?:\s+# duration_ms ([\d.]+))?$/);
    if (passMatch) {
      allTests.push({
        name: passMatch[1].trim(),
        status: "pass",
        durationMs: passMatch[2] ? parseFloat(passMatch[2]) : 0,
      });
      continue;
    }

    const failMatch = line.match(/^not ok \d+ - (.+?)(?:\s+# duration_ms ([\d.]+))?$/);
    if (failMatch) {
      allTests.push({
        name: failMatch[1].trim(),
        status: "fail",
        durationMs: failMatch[2] ? parseFloat(failMatch[2]) : 0,
      });
      continue;
    }

    const skipMatch = line.match(/^ok \d+ - (.+?) # SKIP/);
    if (skipMatch) {
      allTests.push({
        name: skipMatch[1].trim(),
        status: "skip",
        durationMs: 0,
      });
    }
  }

  // Group by iteration
  const iterations: SmokeReport["iterations"] = {};
  for (const test of allTests) {
    const key = classifyIteration(test.name);
    if (!iterations[key]) {
      iterations[key] = { total: 0, pass: 0, fail: 0, tests: [] };
    }
    iterations[key].total++;
    if (test.status === "pass") iterations[key].pass++;
    if (test.status === "fail") iterations[key].fail++;
    iterations[key].tests.push(test);
  }

  const summary = {
    total: allTests.length,
    pass: allTests.filter((t) => t.status === "pass").length,
    fail: allTests.filter((t) => t.status === "fail").length,
    skip: allTests.filter((t) => t.status === "skip").length,
  };

  const report: SmokeReport = {
    timestamp: new Date().toISOString(),
    durationMs,
    summary,
    iterations,
    allTests,
  };

  // Write report
  const reportDir = path.resolve(".agent-core", "reports");
  await mkdir(reportDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(reportDir, `smoke-${ts}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");

  // Print summary
  console.log("");
  console.log("═".repeat(60));
  console.log("🧪 Smoke Test Report");
  console.log("═".repeat(60));
  console.log(`  Total:    ${summary.total}`);
  console.log(`  Pass:     ${summary.pass}`);
  console.log(`  Fail:     ${summary.fail}`);
  console.log(`  Skip:     ${summary.skip}`);
  console.log(`  Duration: ${durationMs}ms`);
  console.log("");

  for (const [key, iter] of Object.entries(iterations).sort()) {
    const icon = iter.fail > 0 ? "✗" : "✓";
    console.log(`  ${icon} ${key}: ${iter.pass}/${iter.total} pass`);
    if (iter.fail > 0) {
      for (const t of iter.tests.filter((t) => t.status === "fail")) {
        console.log(`    ✗ ${t.name}`);
      }
    }
  }

  console.log("");
  console.log(`  Report: ${reportPath}`);
  console.log("");

  if (ciMode && summary.fail > 0) {
    process.exit(1);
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error("Smoke runner failed:", err);
  process.exit(1);
});
