import { randomUUID } from "node:crypto";
import { createInterface, type Interface } from "node:readline/promises";
import process from "node:process";

import { AIMessage, BaseMessage, ToolMessage } from "@langchain/core/messages";

import type { AgentRuntime } from "./agent.js";
import { GuardrailViolationError } from "./guardrails.js";
import { formatActionRequest, getAllowedDecisions } from "./hitl.js";
import { rememberThreadId, resolveInitialThreadId } from "./persistence.js";
import { AgentCoreServiceHarness } from "./service.js";
import type {
  ActionRequest,
  DecisionType,
  HITLDecision,
  HITLRequest,
  HITLResponse,
} from "./types.js";

function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item === "object" && "text" in item) {
          return String((item as { text?: unknown }).text ?? "");
        }
        return JSON.stringify(item, null, 2);
      })
      .join("\n");
  }
  if (content == null) {
    return "";
  }
  return JSON.stringify(content, null, 2);
}

function truncate(text: string, maxLength = 1200): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\n...[truncated]`;
}

function isReadlineClosedError(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "ERR_USE_AFTER_CLOSE";
}

export class AgentCoreCli {
  private readonly runtime: AgentRuntime;
  private readonly rl: Interface;
  private readonly service: AgentCoreServiceHarness;
  private threadId = "";
  private closed = false;

  private constructor(runtime: AgentRuntime) {
    this.runtime = runtime;
    this.service = new AgentCoreServiceHarness(runtime);
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  static async create(runtime: AgentRuntime): Promise<AgentCoreCli> {
    const cli = new AgentCoreCli(runtime);
    cli.threadId = await resolveInitialThreadId(
      runtime.settings.initialThreadId,
      runtime.settings.sessionStatePath,
    );
    return cli;
  }

  async start(): Promise<void> {
    this.printBanner();

    while (true) {
      let rawInput: string;
      try {
        rawInput = await this.rl.question("\nYou: ");
      } catch (error) {
        if (isReadlineClosedError(error)) {
          return;
        }
        throw error;
      }
      const input = rawInput.trim();
      if (!input) {
        continue;
      }
      const commandResult = await this.handleCommand(input);
      if (commandResult === "handled") {
        continue;
      }
      if (commandResult === "exit") {
        return;
      }
      await this.runTurn(input);
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.rl.close();
    await this.runtime.close();
  }

  private printBanner(): void {
    console.log(
      [
        "Agent Core (deepagentsjs)",
        `Model: ${this.runtime.settings.model}`,
        `Prompt profile: ${this.runtime.settings.promptProfile}`,
        `Workspace: ${this.runtime.settings.workspaceDir}`,
        `Thread: ${this.threadId}`,
        "Commands: /help /skills /subagents /thread /new-thread /workspace /quit",
      ].join("\n"),
    );
  }

  private async handleCommand(input: string): Promise<"handled" | "unhandled" | "exit"> {
    switch (input) {
      case "/help":
        console.log(
          [
            "/help        Show commands",
            "/skills      Show configured skills",
            "/subagents   Show configured subagents",
            "/thread      Show current thread id",
            "/new-thread  Start a fresh thread",
            "/workspace   Show workspace root",
            "/quit        Exit CLI",
          ].join("\n"),
        );
        return "handled";
      case "/skills":
        await this.printSkills();
        return "handled";
      case "/subagents":
        await this.printSubagents();
        return "handled";
      case "/thread":
        console.log(`Current thread: ${this.threadId}`);
        return "handled";
      case "/new-thread":
        this.threadId = randomUUID();
        await rememberThreadId(this.runtime.settings.sessionStatePath, this.threadId);
        console.log(`Started new thread: ${this.threadId}`);
        return "handled";
      case "/workspace":
        console.log(`Workspace: ${this.runtime.settings.workspaceDir}`);
        return "handled";
      case "/quit":
        await this.close();
        return "exit";
      default:
        return "unhandled";
    }
  }

  private async printSkills(): Promise<void> {
    if (this.runtime.skillSources.length === 0) {
      console.log("No skill sources configured.");
      return;
    }

    const skills = await this.runtime.listSkills();
    console.log(
      [
        "Skill sources:",
        ...this.runtime.skillSources.map(
          (source) => `- ${source.backendPath} (${source.absolutePath})`,
        ),
      ].join("\n"),
    );

    if (skills.length === 0) {
      console.log("\nNo skills found in configured sources.");
      return;
    }

    console.log(
      [
        "",
        "Skills:",
        ...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
      ].join("\n"),
    );
  }

  private async printSubagents(): Promise<void> {
    const customSubagents = await this.runtime.listSubagents();
    const lines = [
      "General-purpose subagent:",
      `- ${this.runtime.generalPurposeSubagent.name}: ${this.runtime.generalPurposeSubagent.description}`,
    ];

    if (this.runtime.generalPurposeSubagent.inheritedSkillSources.length > 0) {
      lines.push(
        `  inherited skills: ${this.runtime.generalPurposeSubagent.inheritedSkillSources.join(", ")}`,
      );
    }

    if (this.runtime.subagentSources.length === 0) {
      lines.push("", "No custom subagent sources configured.");
      console.log(lines.join("\n"));
      return;
    }

    lines.push(
      "",
      "Custom subagent sources:",
      ...this.runtime.subagentSources.map(
        (source) => `- ${source.backendPath} (${source.absolutePath})`,
      ),
    );

    if (customSubagents.length === 0) {
      lines.push("", "No custom subagents found in configured sources.");
      console.log(lines.join("\n"));
      return;
    }

    lines.push(
      "",
      "Custom subagents:",
      ...customSubagents.map((subagent) => {
        const suffix =
          subagent.skills && subagent.skills.length > 0
            ? ` [skills: ${subagent.skills.join(", ")}]`
            : "";
        return `- ${subagent.name}: ${subagent.description}${suffix}`;
      }),
    );
    console.log(lines.join("\n"));
  }

  private async runTurn(userInput: string): Promise<void> {
    let result;
    try {
      result = await this.service.runOnce({
        threadId: this.threadId,
        input: userInput,
        onInterrupt: async (request) => this.promptForInterruptResolution(request),
      });
    } catch (error) {
      if (error instanceof GuardrailViolationError) {
        console.log(`\n[guardrail:${error.violation.phase}] ${error.message}`);
        return;
      }
      throw error;
    }
    if (this.runtime.settings.verbose) {
      console.log(`\n[trace:${result.traceId}]`);
      if (result.contextCompaction) {
        const filePath = result.contextCompaction.filePath ?? "(memory-only summary)";
        console.log(
          `[compaction:${result.contextCompaction.cutoffIndex}] ${filePath}`,
        );
      }
    }
    this.renderMessages(result.newMessages);

    if (result.status === "interrupted") {
      console.log("\nExecution paused: waiting for an external approval response.");
    }
  }

  private renderMessages(messages: BaseMessage[]): void {
    for (const message of messages) {
      if (AIMessage.isInstance(message)) {
        const text = contentToText(message.content).trim();
        if (text) {
          console.log(`\nAssistant:\n${text}`);
        }
      } else if (ToolMessage.isInstance(message)) {
        const toolName = message.name || "tool";
        const body = truncate(contentToText(message.content));
        console.log(`\n[tool:${toolName}]\n${body}`);
      }
    }
  }

  private async promptForInterruptResolution(request: HITLRequest): Promise<HITLResponse> {
    const decisions: HITLDecision[] = [];

    for (const action of request.actionRequests) {
      const allowed = getAllowedDecisions(request.reviewConfigs, action.name);
      console.log(`\nApproval required:\n${formatActionRequest(action, allowed)}`);
      const decisionType = await this.promptDecision(allowed);

      if (decisionType === "approve") {
        decisions.push({ type: "approve" });
        continue;
      }

      if (decisionType === "edit") {
        decisions.push(await this.promptEditDecision(action));
        continue;
      }

      decisions.push(await this.promptRejectDecision());
    }

    return { decisions };
  }

  private async promptDecision(allowed: DecisionType[]): Promise<DecisionType> {
    const shortcuts = new Map<string, DecisionType>([
      ["a", "approve"],
      ["e", "edit"],
      ["r", "reject"],
    ]);

    while (true) {
      const answer = (
        await this.rl.question(
          `Decision [${allowed.map((item) => item[0]).join("/")}] (${allowed.join(", ")}): `,
        )
      )
        .trim()
        .toLowerCase();

      const resolved = shortcuts.get(answer) ?? (answer as DecisionType);
      if (allowed.includes(resolved)) {
        return resolved;
      }
      console.log("Invalid decision, please try again.");
    }
  }

  private async promptEditDecision(action: ActionRequest): Promise<HITLDecision> {
    const nextName =
      (await this.rl.question(`New tool name [${action.name}]: `)).trim() || action.name;

    while (true) {
      const rawArgs = await this.rl.question(
        "New args JSON (leave empty to keep current args): ",
      );
      if (!rawArgs.trim()) {
        return {
          type: "edit",
          editedAction: {
            name: nextName,
            args: action.args,
          },
        };
      }

      try {
        const parsed = JSON.parse(rawArgs) as Record<string, unknown>;
        if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
          console.log("Args must be a JSON object.");
          continue;
        }
        return {
          type: "edit",
          editedAction: {
            name: nextName,
            args: parsed,
          },
        };
      } catch (error) {
        console.log(`Invalid JSON: ${(error as Error).message}`);
      }
    }
  }

  private async promptRejectDecision(): Promise<HITLDecision> {
    const message = (await this.rl.question("Reject message (optional): ")).trim();
    return message ? { type: "reject", message } : { type: "reject" };
  }
}
