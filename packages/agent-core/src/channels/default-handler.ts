import type { AgentCoreServiceHarness, ServiceStreamEvent } from "../service.js";
import type { ContentBlock, UserInput } from "../types.js";
import { createLogger } from "../logger.js";
import type { Channel, ChannelMessage } from "./channel.js";
import type { ChannelMessageHandler } from "./dispatcher.js";
import { DraftUpdater } from "./draft.js";

const log = createLogger("channel-handler");

// MARK: Default channel message handler
//
// Wires Channel → service.streamRun → DraftUpdater so every IM channel
// gets streaming replies, scope-based preemption, and HITL out of the box.

export interface DefaultHandlerOptions {
  service: AgentCoreServiceHarness;
  /** Throttle ms for draft updates (default 500). */
  draftThrottleMs?: number;
}

/**
 * Create the default ChannelMessageHandler.
 *
 * Usage:
 * ```
 * dispatcher.setHandler(createDefaultHandler({ service }));
 * ```
 */
export function createDefaultHandler(
  options: DefaultHandlerOptions,
): ChannelMessageHandler {
  const { service, draftThrottleMs } = options;

  return async (
    message: ChannelMessage,
    channel: Channel,
    signal: AbortSignal,
  ): Promise<void> => {
    log.info("handle.start", {
      channelName: message.channelName,
      scopeKey: message.scopeKey,
      threadId: message.threadId,
    });

    // Build input: text, or text + images as multimodal ContentBlock[].
    const input = buildInput(message);

    // Set up draft updater for streaming replies.
    const draft = new DraftUpdater(channel, message.replyTarget, draftThrottleMs);

    try {
      const stream = service.streamRun({
        threadId: message.threadId,
        input,
        scopeKey: message.scopeKey,
        toolProfile: message.toolProfile,
        signal,
      });

      for await (const event of stream) {
        if (signal.aborted) break;
        await handleEvent(event, draft, channel, message);
      }

      await draft.finalize();
      log.info("handle.done", {
        channelName: message.channelName,
        scopeKey: message.scopeKey,
      });
    } catch (err) {
      await draft.cancel();
      // AbortError from preemption — expected, don't notify user.
      if (signal.aborted) {
        log.info("handle.preempted", { scopeKey: message.scopeKey });
        return;
      }
      // Real error — try to inform the user.
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error("handle.error", {
        channelName: message.channelName,
        scopeKey: message.scopeKey,
        error: errorMsg,
      });
      try {
        await channel.send(
          message.replyTarget,
          `⚠️ Error: ${errorMsg.slice(0, 200)}`,
        );
      } catch {
        // swallow — best-effort error notification
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildInput(message: ChannelMessage): UserInput {
  if (!message.images || message.images.length === 0) {
    return message.text;
  }
  const blocks: ContentBlock[] = [{ type: "text", text: message.text }];
  for (const uri of message.images) {
    blocks.push({ type: "image_url", image_url: { url: uri } });
  }
  return blocks;
}

async function handleEvent(
  event: ServiceStreamEvent,
  draft: DraftUpdater,
  channel: Channel,
  message: ChannelMessage,
): Promise<void> {
  switch (event.type) {
    case "text_delta":
      draft.push(event.delta);
      break;

    case "run_interrupted":
      await sendApprovalOrFallback(event, draft, channel, message);
      break;

    case "tool_failed":
      // Surface tool errors in the stream so the user sees them.
      if (event.error) {
        const msg = typeof event.error === "string" ? event.error : String(event.error);
        draft.push(`\n\n⚠️ Tool error: ${msg.slice(0, 100)}`);
      }
      break;

    // text_delta is the main event; others (run_started, tool_started, etc.)
    // are ignored for now — they don't affect the reply text.
  }
}

async function sendApprovalOrFallback(
  event: Extract<ServiceStreamEvent, { type: "run_interrupted" }>,
  draft: DraftUpdater,
  channel: Channel,
  message: ChannelMessage,
): Promise<void> {
  const request = event.result.interruptRequest;
  const body = formatApprovalBody(request);

  // Channels that support interactive approval: finalize the current draft
  // with whatever has been streamed so far, then send a separate card.
  if (typeof channel.sendApprovalCard === "function") {
    try {
      await draft.finalize();
    } catch {
      // best-effort
    }
    try {
      await channel.sendApprovalCard(message.replyTarget, {
        threadId: message.threadId,
        title: "Needs approval",
        body,
      });
      return;
    } catch (err) {
      log.warn("sendApprovalCard.failed", {
        channelName: message.channelName,
        error: err instanceof Error ? err.message : String(err),
      });
      // Fall through to inline fallback.
    }
  }

  // Fallback — append inline note to the draft.
  draft.push("\n\n⏸ Needs approval — approve via the Mantle app");
}

function formatApprovalBody(request: unknown): string {
  if (!request || typeof request !== "object") {
    return "The agent is requesting approval to run a sensitive tool.";
  }
  const actions = (request as { actionRequests?: Array<{ name: string; args?: unknown }> })
    .actionRequests;
  if (!Array.isArray(actions) || actions.length === 0) {
    return "The agent is requesting approval to continue.";
  }
  const lines = actions.map((a) => {
    const args = a.args ?? {};
    const preview = Object.entries(args as Record<string, unknown>)
      .slice(0, 3)
      .map(([k, v]) => `- ${k}: ${String(v).slice(0, 60)}`)
      .join("\n");
    return `**${a.name}**${preview ? `\n${preview}` : ""}`;
  });
  return lines.join("\n\n---\n\n");
}
