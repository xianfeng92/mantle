// MARK: twitter-digest
//
// Ambient 阅读系统的 AI 消化层。由 Mantle 的 TwitterBookmarkDaemon 定时调用。
//
// 与主 agent 解耦：不走 deepagents subagent 机制（gemma tool-call 不稳），
// 直接 new ChatOpenAI 发起一次性对话，prompt 硬约束输出 JSON，zod 校验 + 一次重试。
//
// 三个 mode：
//   - summarize: 输入原始推文 → 返回 items (summary/qualityScore/tags)
//   - daily:    输入【已 summarized】推文 → 返回 items + topPicks + rationale
//   - weekly:   输入【已 summarized】推文 → 返回 clusters (主题聚类)

import { ChatOpenAI } from "@langchain/openai";
import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";

import type { AgentCoreSettings } from "./settings.js";
import { createLogger } from "./logger.js";
import type { ReturnDraft } from "./returns.js";

const log = createLogger("twitter-digest");

// ---------------------------------------------------------------------------
// Input / output schemas
// ---------------------------------------------------------------------------

// summarize mode: 原始推文
export const SummarizeInputBookmarkSchema = z.object({
  id: z.string().min(1),
  author: z.string(),
  text: z.string(),
  quotedText: z.string().optional(),
});

// daily / weekly mode: 已处理的推文（必带 summary/score/tags）
export const DigestedBookmarkSchema = z.object({
  id: z.string().min(1),
  author: z.string(),
  summary: z.string(),
  qualityScore: z.number().int().min(1).max(10),
  tags: z.array(z.string()).default([]),
});

export const TwitterDigestRequestSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("summarize"),
    bookmarks: z.array(SummarizeInputBookmarkSchema).min(1).max(20),
  }),
  z.object({
    mode: z.literal("daily"),
    bookmarks: z.array(DigestedBookmarkSchema).min(1).max(50),
  }),
  z.object({
    mode: z.literal("weekly"),
    bookmarks: z.array(DigestedBookmarkSchema).min(2).max(150),
  }),
]);

export type TwitterDigestRequest = z.infer<typeof TwitterDigestRequestSchema>;

// 输出 schemas
const DigestItemSchema = z.object({
  id: z.string(),
  summary: z.string(),
  qualityScore: z.number().int().min(1).max(10),
  tags: z.array(z.string()).max(5),
});

export const SummarizeResponseSchema = z.object({
  items: z.array(DigestItemSchema),
});

export const DailyResponseSchema = z.object({
  topPicks: z.array(z.string()).min(1).max(7),
  rationale: z.string(),
});

const WeeklyClusterSchema = z.object({
  theme: z.string(),
  bookmarkIds: z.array(z.string()).min(1),
  narrative: z.string(),
});

export const WeeklyResponseSchema = z.object({
  clusters: z.array(WeeklyClusterSchema),
  orphans: z.array(z.string()).default([]),
});

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

// Reader profile：所有总结/选择/聚类都从这个具体读者的视角输出。
// 调整这段 = 调整 Mantle 整套 Ambient 系统的"嗓音"。改之前先看 docs/specs/2026-04-14-twitter-ambient-spec.md 的"读者画像"章节。
const READER_PROFILE = `# 读者画像（决定所有 summary / score / tags / picks / clusters 的视角）
- 蔚来语音架构师；业余做 Mantle (macOS Desktop AI Agent, SwiftUI + agent-core + gemma 4 26B)
- 用过 Claude / Codex / Gemini 多 agent 协作

## 关注（评分加权 +1~+2）
- 本地 AI / 端侧推理 / Apple Silicon
- macOS OS 集成（Spotlight / Shortcuts / Services / App Intents / AppleScript）
- Agent 工程（subagent, middleware, HITL, prompt design）
- Desktop-First / Ambient AI 产品形态
- 跨工具 agent 协作模式

## 风格要求（强约束）
- 不写"该文章探讨了" / "本文介绍了" 这种导览套话；直接给观点 + 数据 + actionable
- 技术术语保留英文（embedding / RAG / fine-tune / subagent 不硬翻）
- 对 Mantle / agent-core 项目有启发的点要明示
- summary 字段是给"已经懂行的工程师"看的，不要解释基础概念

## 降权（qualityScore -2）
融资八卦 / 大模型排行帖 / Career 套话 / 金融加密 / 政治`;

const BASE_SYSTEM = `You are a Twitter bookmark curator for a specific reader described below.

${READER_PROFILE}

## 输出绝对规则
- Output STRICT JSON ONLY. No prose before or after.
- No markdown code fences (\`\`\`). No explanations. No "here is the JSON".
- First char must be "{". Last char must be "}".
- If you violate this, downstream parser will reject your answer.`;

const SUMMARIZE_SYSTEM = `${BASE_SYSTEM}

MODE: summarize
Task: for EACH input bookmark produce a summary, qualityScore, and tags.

Rules:
- summary: ≤60 Chinese chars (or ≤40 English words). Capture the INSIGHT, not the topic. If input is Chinese, summary in Chinese; if English, Chinese summary is fine.
- qualityScore: 1-10 integer.
  * 10 = rare insight / original data / deep analysis worth returning to.
  * 7-9 = solid take with evidence.
  * 4-6 = decent opinion, no strong new info.
  * 1-3 = joke, meme, pure retweet, or noise.
- tags: 1-3 lowercase kebab-case English tags (e.g. "ai-agents", "rag", "startup").

Output schema:
{ "items": [ { "id": string, "summary": string, "qualityScore": number, "tags": string[] } ] }

Process ALL input items in order. Do not truncate. Do not skip low-quality ones (still summarize them, just low score).`;

const DAILY_SYSTEM = `${BASE_SYSTEM}

MODE: daily
Task: pick 3-5 most-worth-reading bookmarks from today's input.

Input items already have summary/qualityScore/tags. You choose.

Rules:
- Prefer high qualityScore (≥7).
- Prefer topic diversity — do NOT pick 4 AI items if input has varied topics.
- If input <3 items, include all of them.
- rationale: 1-2 sentence Chinese explanation of why these picks (not per-item, overall).

Output schema:
{ "topPicks": string[], "rationale": string }`;

const WEEKLY_SYSTEM = `${BASE_SYSTEM}

MODE: weekly
Task: cluster the week's bookmarks by SEMANTIC THEME, not by keyword.

Input items already have summary/qualityScore/tags.

Rules:
- Each cluster needs ≥2 bookmarks. Singletons go to orphans.
- theme: 2-6 Chinese chars, describe the underlying theme (e.g. "Agent 架构演进", not just "agent").
- narrative: 2-3 Chinese sentences explaining what the cluster's bookmarks collectively say.
- A bookmark id appears in AT MOST one cluster.

Output schema:
{ "clusters": [ { "theme": string, "bookmarkIds": string[], "narrative": string } ], "orphans": string[] }`;

function systemFor(mode: TwitterDigestRequest["mode"]): string {
  switch (mode) {
    case "summarize":
      return SUMMARIZE_SYSTEM;
    case "daily":
      return DAILY_SYSTEM;
    case "weekly":
      return WEEKLY_SYSTEM;
  }
}

function schemaFor(mode: TwitterDigestRequest["mode"]): z.ZodTypeAny {
  switch (mode) {
    case "summarize":
      return SummarizeResponseSchema;
    case "daily":
      return DailyResponseSchema;
    case "weekly":
      return WeeklyResponseSchema;
  }
}

// ---------------------------------------------------------------------------
// JSON extraction + retry
// ---------------------------------------------------------------------------

/** 从 LLM 输出中提取 JSON：去除 markdown 围栏，找第一个 {...}。 */
export function extractJsonObject(text: string): unknown {
  let cleaned = text.trim();

  // 去掉 ```json ... ``` 或 ``` ... ``` 围栏
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1]!.trim();
  }

  // 找第一个 '{' 和对应最后一个 '}'
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error(
      `No JSON object found in model output: ${cleaned.slice(0, 200)}${cleaned.length > 200 ? "..." : ""}`,
    );
  }

  const candidate = cleaned.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(candidate);
  } catch (err) {
    throw new Error(
      `JSON parse failed: ${(err as Error).message}; candidate: ${candidate.slice(0, 200)}`,
    );
  }
}

function extractText(response: unknown): string {
  const content = (response as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((chunk) => {
        if (typeof chunk === "string") return chunk;
        if (chunk && typeof chunk === "object" && "text" in chunk) {
          return String((chunk as { text: unknown }).text ?? "");
        }
        return "";
      })
      .join("");
  }
  return String(content ?? "");
}

/**
 * 调用模型并严格校验输出。最多一次重试：首次失败时把"你的输出违反了 schema"
 * 作为 user message 追加回去，再 invoke 一次。
 */
async function invokeWithRetry(
  model: ChatOpenAI,
  messages: BaseMessage[],
  schema: z.ZodTypeAny,
): Promise<unknown> {
  let currentMessages = messages;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const startedAt = Date.now();
    const response = await model.invoke(currentMessages);
    const durationMs = Date.now() - startedAt;
    const rawText = extractText(response);

    try {
      const parsed = extractJsonObject(rawText);
      const validated = schema.parse(parsed);
      log.info("digest.invoke.ok", { attempt, durationMs, bytes: rawText.length });
      return validated;
    } catch (err) {
      lastError = err as Error;
      log.warn("digest.invoke.badOutput", {
        attempt,
        durationMs,
        reason: lastError.message.slice(0, 200),
        preview: rawText.slice(0, 200),
      });
      // 追加纠正 message，再给一次机会
      currentMessages = [
        ...currentMessages,
        new HumanMessage(
          `Your previous output was rejected: ${lastError.message}\n\n` +
            `Output ONLY valid JSON matching the schema. First char must be "{". No prose, no fences, no explanation.`,
        ),
      ];
    }
  }

  throw lastError ?? new Error("digest.invoke.failed");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** 从 AgentCoreSettings 构造一个瞬时 ChatOpenAI（不沾染主 agent 的 thread/checkpoint）。 */
function buildModel(settings: AgentCoreSettings): ChatOpenAI {
  return new ChatOpenAI({
    model: settings.model,
    temperature: 0,
    apiKey: settings.apiKey,
    configuration: settings.baseUrl ? { baseURL: settings.baseUrl } : undefined,
    // gemma + LM Studio 默认 max_tokens 偏低（~1500），15 条 batch 会被截断。
    // 给 4096 token 余量：~13 条 × 300 token output ≈ 3900 + 容错。
    maxTokens: 4096,
  });
}

/**
 * Build a Returns Plane draft from a digest result. Returns null for modes
 * that should not be persisted by default (currently only `summarize`, which
 * is an intermediate product — the daily/weekly steps consume it).
 */
export function buildDigestReturnDraft(
  request: TwitterDigestRequest,
  result: unknown,
): ReturnDraft | null {
  const createdAt = new Date().toISOString();
  const dateTag = createdAt.slice(0, 10);

  if (request.mode === "daily") {
    const parsed = DailyResponseSchema.safeParse(result);
    if (!parsed.success) return null;
    return {
      kind: "twitter-digest.daily",
      title: `今日精选 ${parsed.data.topPicks.length} 条`,
      summary: parsed.data.rationale,
      payload: {
        mode: "daily",
        input: request.bookmarks,
        output: parsed.data,
      },
      tags: ["twitter-digest", "daily", dateTag],
      source: { taskId: "twitter-digest.daily" },
    };
  }

  if (request.mode === "weekly") {
    const parsed = WeeklyResponseSchema.safeParse(result);
    if (!parsed.success) return null;
    const summary = parsed.data.clusters
      .map((c) => `${c.theme} (${c.bookmarkIds.length})`)
      .join(" · ");
    return {
      kind: "twitter-digest.weekly",
      title: `本周聚类 ${parsed.data.clusters.length} 簇`,
      summary,
      payload: {
        mode: "weekly",
        input: request.bookmarks,
        output: parsed.data,
      },
      tags: ["twitter-digest", "weekly", dateTag],
      source: { taskId: "twitter-digest.weekly" },
    };
  }

  return null;
}

/** Default persistence policy by mode. `summarize` is intermediate and skipped. */
export function defaultPersistForMode(mode: TwitterDigestRequest["mode"]): boolean {
  return mode === "daily" || mode === "weekly";
}

export async function generateDigest(
  request: TwitterDigestRequest,
  settings: AgentCoreSettings,
): Promise<unknown> {
  const model = buildModel(settings);

  const userPayload = {
    mode: request.mode,
    bookmarks: request.bookmarks,
  };

  const messages: BaseMessage[] = [
    new SystemMessage(systemFor(request.mode)),
    new HumanMessage(JSON.stringify(userPayload, null, 0)),
  ];

  log.info("digest.start", {
    mode: request.mode,
    count: request.bookmarks.length,
    model: settings.model,
  });

  const result = await invokeWithRetry(model, messages, schemaFor(request.mode));

  log.info("digest.done", { mode: request.mode, count: request.bookmarks.length });
  return result;
}
