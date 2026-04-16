// MARK: Channels bootstrap
//
// Single entry point for wiring up all configured IM channels at startup.
// Reads settings, builds a ChannelDispatcher with the default handler,
// registers each enabled channel, and starts them.
//
// Call `setupChannels(runtime)` from serve.ts after the runtime is ready.

import { AgentCoreServiceHarness } from "../service.js";
import type { AgentRuntime } from "../agent.js";
import { createLogger } from "../logger.js";

import { ChannelDispatcher } from "./dispatcher.js";
import { createDefaultHandler } from "./default-handler.js";
import { FeishuChannel } from "./feishu.js";

const log = createLogger("channels");

export interface ChannelsBootstrapResult {
  dispatcher: ChannelDispatcher;
  service: AgentCoreServiceHarness;
  /** Gracefully stop all channels. Call on shutdown. */
  stop: () => Promise<void>;
}

/**
 * Set up and start all channels configured via environment variables.
 *
 * Returns the dispatcher (for future programmatic access) and a stop()
 * function. If no channels are configured, returns an empty dispatcher
 * with stop() as a no-op.
 */
export async function setupChannels(
  runtime: AgentRuntime,
): Promise<ChannelsBootstrapResult> {
  const dispatcher = new ChannelDispatcher();
  const service = new AgentCoreServiceHarness(runtime);
  dispatcher.setHandler(createDefaultHandler({ service }));

  const settings = runtime.settings;

  // -- Feishu --
  if (settings.feishuAppId && settings.feishuAppSecret) {
    const feishu = new FeishuChannel({
      appId: settings.feishuAppId,
      appSecret: settings.feishuAppSecret,
      allowedChatIds: settings.feishuAllowedChatIds.length > 0
        ? settings.feishuAllowedChatIds
        : undefined,
    });
    feishu.setService(service);
    dispatcher.registerChannel(feishu);
    log.info("feishu.configured", {
      allowedChatIds: settings.feishuAllowedChatIds.length,
    });
  }

  if (dispatcher.registeredChannels.length === 0) {
    log.info("no channels configured — skipping");
    return {
      dispatcher,
      service,
      stop: async () => {},
    };
  }

  try {
    await dispatcher.startAll();
    log.info("started", { channels: dispatcher.registeredChannels });
  } catch (err) {
    log.error("startAll.failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    // Don't crash the server — channels are optional
  }

  return {
    dispatcher,
    service,
    stop: () => dispatcher.stopAll(),
  };
}
