import "dotenv/config";

import { createAgentRuntime } from "./agent.js";
import { AgentCoreCli } from "./cli.js";
import { setLogLevel, type LogLevel } from "./logger.js";
import { loadSettings } from "./settings.js";

async function main(): Promise<void> {
  const settings = loadSettings();
  const logLevel = (process.env.AGENT_CORE_LOG_LEVEL ?? (settings.verbose ? "debug" : "info")) as LogLevel;
  setLogLevel(logLevel);
  const runtime = await createAgentRuntime(settings);
  const cli = await AgentCoreCli.create(runtime);

  try {
    await cli.start();
  } finally {
    await cli.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exit(1);
});
