export interface FeishuStepAssertions {
  allOf?: string[];
  anyOf?: string[];
  noneOf?: string[];
}

export interface FeishuCaseStep {
  id?: string;
  prompt: string;
  replyTimeoutMs?: number;
  settleMs?: number;
  assertions?: FeishuStepAssertions;
}

export interface FeishuTestCase {
  id: string;
  title: string;
  notes?: string;
  steps: FeishuCaseStep[];
}

export interface FeishuCasePack {
  suiteName: string;
  description?: string;
  defaultReplyTimeoutMs?: number;
  defaultSettleMs?: number;
  cases: FeishuTestCase[];
}

export const defaultFeishuCasePack: FeishuCasePack = {
  suiteName: "mantle-feishu-smoke-v1",
  description:
    "Direct-chat smoke suite for Mantle's Feishu channel. Covers slash commands, rich card replies, and one normal chat turn.",
  defaultReplyTimeoutMs: 45_000,
  defaultSettleMs: 4_000,
  cases: [
    {
      id: "reset-then-status",
      title: "Reset thread and confirm empty session",
      steps: [
        {
          id: "reset",
          prompt: "/new",
          assertions: {
            allOf: ["已开新会话"],
          },
        },
        {
          id: "status",
          prompt: "/status",
          assertions: {
            allOf: ["当前没有活跃会话"],
          },
        },
      ],
    },
    {
      id: "help",
      title: "Help command returns supported slash commands",
      steps: [
        {
          prompt: "/help",
          assertions: {
            allOf: ["可用命令", "/summarize", "/find"],
          },
        },
      ],
    },
    {
      id: "summarize-usage",
      title: "Summarize without payload returns usage hint",
      steps: [
        {
          prompt: "/summarize",
          assertions: {
            allOf: ["用法", "/summarize"],
          },
        },
      ],
    },
    {
      id: "summarize-news",
      title: "Summarize one short market-news paragraph",
      steps: [
        {
          prompt:
            "/summarize 苹果刚公布本季度 iPhone 销量创纪录，Pro 机型在中国市场尽管经济放缓但依然强势，服务业务拉动毛利率提升 2 个百分点。",
          replyTimeoutMs: 60_000,
          assertions: {
            allOf: ["要点", "评分"],
          },
        },
      ],
    },
    {
      id: "find-feishu",
      title: "Find command returns Feishu channel files",
      steps: [
        {
          prompt: "/find feishu",
          assertions: {
            allOf: ["个文件匹配", "src/channels/feishu.ts"],
          },
        },
      ],
    },
    {
      id: "unknown-command",
      title: "Unknown slash command is rejected cleanly",
      steps: [
        {
          prompt: "/not-a-real-command",
          assertions: {
            allOf: ["未知命令", "/help"],
          },
        },
      ],
    },
    {
      id: "plain-chat",
      title: "Normal chat message still gets a direct model reply",
      notes:
        "This is the only model-behavior case in the default suite. The assertion is intentionally loose.",
      steps: [
        {
          prompt: "请在回复中包含字符串 FEISHU_BATCH_OK，并简短说明你已收到测试消息。",
          replyTimeoutMs: 60_000,
          assertions: {
            allOf: ["FEISHU_BATCH_OK"],
          },
        },
      ],
    },
  ],
};
