import assert from "node:assert/strict";
import test from "node:test";

import { loadSettings, resolvePromptProfile } from "../src/settings.js";

test("loadSettings resolves workspace and defaults", () => {
  const settings = loadSettings({
    cwd: "/tmp/project",
    env: {
      AGENT_CORE_WORKSPACE_DIR: "./workspace",
      AGENT_CORE_VIRTUAL_MODE: "0",
      AGENT_CORE_VERBOSE: "0",
    },
  });

  assert.equal(settings.model, "google/gemma-4-26b-a4b");
  assert.equal(settings.baseUrl, "http://127.0.0.1:1234/v1");
  assert.equal(settings.promptProfile, "compact");
  assert.equal(settings.agentGraphVersion, "v2");
  assert.equal(settings.workspaceDir, "/tmp/project/workspace");
  assert.equal(settings.dataDir, "/tmp/project/workspace/.agent-core");
  assert.equal(
    settings.checkpointDbPath,
    "/tmp/project/workspace/.agent-core/checkpoints.sqlite",
  );
  assert.equal(settings.sessionStatePath, "/tmp/project/workspace/.agent-core/session.json");
  assert.equal(settings.traceLogPath, "/tmp/project/workspace/.agent-core/traces.jsonl");
  assert.equal(settings.httpHost, "127.0.0.1");
  assert.equal(settings.httpPort, 8787);
  assert.equal(settings.virtualMode, false);
  assert.equal(settings.verbose, false);
  assert.equal(settings.maxInputChars, 20_000);
  assert.equal(settings.maxOutputChars, 80_000);
  assert.deepEqual(settings.blockedInputTerms, []);
  assert.deepEqual(settings.blockedOutputTerms, []);
  assert.deepEqual(settings.skillSourcePaths, []);
  assert.deepEqual(settings.subagentSourcePaths, []);
  assert.equal(settings.contextWindowTokensHint, 28_000);
  assert.equal(settings.apiKey, "lm-studio");
  assert.equal(settings.initialThreadId, undefined);
});

test("loadSettings reads OpenAI compatibility env vars", () => {
  const settings = loadSettings({
    cwd: "/tmp/project",
    env: {
      OPENAI_MODEL: "local-llm",
      OPENAI_BASE_URL: "http://localhost:1234/v1",
      OPENAI_API_KEY: "secret",
      AGENT_CORE_DATA_DIR: ".agent-runtime",
      AGENT_CORE_CHECKPOINT_DB_PATH: "./state/agent.sqlite",
      AGENT_CORE_SESSION_STATE_PATH: "./state/session.json",
      AGENT_CORE_TRACE_LOG_PATH: "./state/traces.jsonl",
      AGENT_CORE_HTTP_HOST: "0.0.0.0",
      AGENT_CORE_HTTP_PORT: "9999",
      AGENT_CORE_AGENT_GRAPH_VERSION: "v1",
      AGENT_CORE_MAX_INPUT_CHARS: "512",
      AGENT_CORE_MAX_OUTPUT_CHARS: "2048",
      AGENT_CORE_BLOCKED_INPUT_TERMS: "password,secret",
      AGENT_CORE_BLOCKED_OUTPUT_TERMS: "token\ncredential",
      AGENT_CORE_SKILL_SOURCE_PATHS: ".deepagents/skills,team-skills",
      AGENT_CORE_SUBAGENT_SOURCE_PATHS: ".deepagents/subagents,team-subagents",
      AGENT_CORE_CONTEXT_WINDOW_TOKENS_HINT: "4096",
      AGENT_CORE_THREAD_ID: "thread-123",
    },
  });

  assert.equal(settings.model, "local-llm");
  assert.equal(settings.baseUrl, "http://localhost:1234/v1");
  assert.equal(settings.apiKey, "secret");
  assert.equal(settings.promptProfile, "default");
  assert.equal(settings.agentGraphVersion, "v1");
  assert.equal(settings.dataDir, "/tmp/project/.agent-runtime");
  assert.equal(settings.checkpointDbPath, "/tmp/project/state/agent.sqlite");
  assert.equal(settings.sessionStatePath, "/tmp/project/state/session.json");
  assert.equal(settings.traceLogPath, "/tmp/project/state/traces.jsonl");
  assert.equal(settings.httpHost, "0.0.0.0");
  assert.equal(settings.httpPort, 9999);
  assert.equal(settings.maxInputChars, 512);
  assert.equal(settings.maxOutputChars, 2048);
  assert.deepEqual(settings.blockedInputTerms, ["password", "secret"]);
  assert.deepEqual(settings.blockedOutputTerms, ["token", "credential"]);
  assert.deepEqual(settings.skillSourcePaths, [".deepagents/skills", "team-skills"]);
  assert.deepEqual(settings.subagentSourcePaths, [
    ".deepagents/subagents",
    "team-subagents",
  ]);
  assert.equal(settings.contextWindowTokensHint, 4096);
  assert.equal(settings.virtualMode, true);
  assert.equal(settings.initialThreadId, "thread-123");
});

test("resolvePromptProfile defaults Gemma models to compact", () => {
  assert.equal(resolvePromptProfile(undefined, "google/gemma-4-27b"), "compact");
  assert.equal(resolvePromptProfile(undefined, "gpt-4.1"), "default");
});

test("resolvePromptProfile respects explicit override", () => {
  assert.equal(resolvePromptProfile("default", "google/gemma-4-27b"), "default");
  assert.equal(resolvePromptProfile("full", "google/gemma-4-27b"), "default");
  assert.equal(resolvePromptProfile("compact", "gpt-4.1"), "compact");
});
