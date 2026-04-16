import "dotenv/config";

import { createAgentRuntime } from "./agent.js";
import { setupChannels } from "./channels/bootstrap.js";
import { AgentCoreHttpServer } from "./http.js";
import { createLogger, setLogLevel, type LogLevel } from "./logger.js";
import { loadSettings } from "./settings.js";

const log = createLogger("serve");

async function main(): Promise<void> {
  const settings = loadSettings();
  // AGENT_CORE_LOG_LEVEL=debug|info|warn|error
  const logLevel = (process.env.AGENT_CORE_LOG_LEVEL ?? (settings.verbose ? "debug" : "info")) as LogLevel;
  setLogLevel(logLevel);
  const runtime = await createAgentRuntime(settings);
  const httpServer = new AgentCoreHttpServer(runtime, {
    host: settings.httpHost,
    port: settings.httpPort,
  });

  // Start configured IM channels (feishu, …). No-op if none configured.
  const channels = await setupChannels(runtime);

  const shutdown = async (signal: string): Promise<void> => {
    log.info("shutdown", { signal });
    await channels.stop();
    await httpServer.close();
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  const address = await httpServer.listen();
  log.info("listening", {
    host: address.host,
    port: address.port,
    model: settings.model,
    logLevel,
    channels: channels.dispatcher.registeredChannels,
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exit(1);
});
