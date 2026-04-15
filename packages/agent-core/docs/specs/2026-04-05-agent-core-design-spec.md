---
title: Agent Core + Harness 设计规格书
status: implemented
owner: claude
created: 2026-04-05
updated: 2026-04-06
implements:
  - README.md
  - src/agent.ts
  - src/cli.ts
  - src/compaction.ts
  - src/guardrails.ts
  - src/hitl.ts
  - src/http.ts
  - src/index.ts
  - src/persistence.ts
  - src/serve.ts
  - src/service.ts
  - src/settings.ts
  - src/skills.ts
  - src/subagents.ts
  - src/system-prompt.ts
  - src/tracing.ts
  - src/types.ts
  - tests/http.test.ts
  - tests/guardrails.test.ts
  - tests/persistence.test.ts
  - tests/runtime-smoke.test.ts
  - tests/service.test.ts
  - tests/settings.test.ts
  - tests/skills.test.ts
  - tests/subagents.test.ts
  - tests/tracing.test.ts
  - tests/hitl.test.ts
  - package.json
  - tsconfig.json
  - .env.example
  - docs/changes/2026-04-05-agent-core-deepagentsjs-pivot-impl-notes.md
  - docs/changes/2026-04-06-agent-core-http-service-impl-notes.md
  - docs/changes/2026-04-06-agent-core-onboarding-and-smoke-impl-notes.md
  - docs/changes/2026-04-06-agent-core-streaming-impl-notes.md
  - docs/changes/2026-04-06-agent-core-guardrails-impl-notes.md
  - docs/changes/2026-04-06-agent-core-context-compaction-impl-notes.md
  - docs/changes/2026-04-06-agent-core-tracing-impl-notes.md
  - docs/changes/2026-04-06-agent-core-skill-system-impl-notes.md
  - docs/changes/2026-04-06-agent-core-multi-agent-handoff-impl-notes.md
  - docs/changes/2026-04-06-agent-core-parallel-tool-calls-impl-notes.md
reviews:
  - docs/reviews/2026-04-05-agent-core-design-review.md
---

> **Note**: Implementation pivoted from Python to TypeScript + deepagentsjs. See `docs/changes/` for details.

# Agent Core + Harness 设计规格书

> 一个轻量级、语言无关的 AI agent 框架。当前工作实现为 TypeScript + `deepagentsjs`，核心执行协议仍面向跨语言迁移设计。

## 0. 文档状态

- 2026-04-05 起，仓库中的活跃实现已经从自研 Python MVP 切换为 `TypeScript + deepagentsjs`
- 当前可运行代码以 `src/*.ts`、`tests/*.test.ts`、`package.json` 为准
- 下文保留的 Python 风格接口和伪代码，主要用于描述跨语言协议与设计意图，不再等同于当前代码布局
- 旧 Python 原型源码已经从仓库移除，相关实现说明仅保留为历史文档

## 1. 目标与约束

### 1.1 项目目标

构建一个可复用的 agent 框架/SDK，具备以下能力：

- 驱动 LLM 完成多轮工具调用（agentic loop）
- 可插拔的工具系统，通过装饰器注册
- 可插拔的响应解析，适配不同模型的 tool call 格式
- 提供 CLI harness 用于在 Mac 上交互式运行和调试
- 提供最小 HTTP 服务，便于 Web / App / 自动化进程复用同一执行协议
- 核心抽象足够简单，后续可用 Kotlin 在 Android 上重新实现

### 1.2 核心约束

| 约束 | 说明 |
|------|------|
| 运行时 | TypeScript + Node.js，本地通过 `npm` 脚本运行 |
| 依赖 | `deepagents`、`langchain`、`@langchain/openai`、`@langchain/langgraph`、`typescript`、`tsx` |
| LLM 后端 | 第一版只支持 OpenAI 兼容 API（LM Studio / Ollama / vLLM） |
| 模型 | 默认使用 OpenAI 兼容 chat model，建议优先对接本地或私有部署模型 |
| 跨平台 | 当前实现基于 `deepagentsjs`，协议层仍可映射到 Kotlin/Android |

### 1.3 与 DecisionF/Android Mobile Agent Spec 的关系

本框架实现的是该 spec 中的 **Agent 核心层 + 工具层**。以下模块不在本框架范围内，属于 Android 特有：

- I/O 抽象层（InputChannel / OutputChannel）
- 语音模块（KWS / VAD / ASR / TTS）
- ConfidenceRouter（端云分流）
- Android 侧 SkillRouter / 移动端 skill orchestration（后续扩展）

### 1.4 设计原则

1. **Harness = 模型的操作系统**。框架的职责是让模型变成 agent。
2. **Message array 是唯一状态**。不引入额外状态机。
3. **最小抽象**。第一版只保留 Agent、Tool、Runner、Config 及必要配套协议。
4. **从简单开始，按需增加复杂度**。先让同步串行执行闭环，再谈 streaming、并行和 compaction。
5. **先定义执行协议，再扩展功能**。权限、多工具调用、错误回传必须先闭环。

---

## 2. 架构总览

```
┌─────────────────────────────────────┐
│  Interface Layer（交互界面，可替换）   │
│  ├── CLI REPL (TypeScript)          │
│  └── Android Activity (Kotlin) [后续]│
├─────────────────────────────────────┤
│  Harness Layer（运行时环境）          │
│  ├── Runner (执行编排)               │
│  ├── Hooks (生命周期拦截)            │
│  └── Permission Policy (权限控制)    │
├─────────────────────────────────────┤
│  Agent Core（核心抽象）               │
│  ├── ToolRegistry (@tool 装饰器)     │
│  ├── MessageStore (消息数组)         │
│  └── AgentConfig (全局配置)          │
├─────────────────────────────────────┤
│  LLM Client + Response Parser        │
│  ├── OpenAICompatibleClient (HTTP)   │
│  └── ResponseParser (可插拔)         │
│      ├── OpenAIParser               │
│      ├── Gemma4Parser               │
│      └── ContentFallbackParser      │
└─────────────────────────────────────┘
```

### 2.1 分层职责

| 层 | 职责 | 跨平台策略 |
|----|------|-----------|
| Interface | 用户交互（输入/输出/渲染） | 当前为 TypeScript CLI + 最小 HTTP 服务，Android 端后续补齐 |
| Harness | 驱动 agent 运转：循环、权限、hooks | 当前由 `deepagentsjs` + LangGraph checkpointer 承担 |
| Agent Core | 工具能力、工作区约束、配置 | 当前主要由 `LocalShellBackend` 和本地配置封装承担 |
| LLM Client | HTTP 通信 + 响应解析 | 当前使用 `@langchain/openai` 的 OpenAI 兼容客户端 |

### 2.3 当前实现映射

| 设计概念 | 当前实现 |
|---------|----------|
| Runner | `src/agent.ts` 中的 `createAgentRuntime()` + `deepagentsjs` agent |
| Service Harness | `src/service.ts` 中的 `runOnce()` / `resumeOnce()` |
| Permission Policy | `src/hitl.ts` 中的 `interruptOn` 配置 |
| CLI Harness | `src/cli.ts` |
| HTTP Harness | `src/http.ts` + `src/serve.ts` |
| Session Persistence | `src/persistence.ts` + `.agent-core/session.json` |
| Trace Recorder | `src/tracing.ts` + `.agent-core/traces.jsonl` |
| Context Compaction | `deepagents` summarization middleware + `src/compaction.ts` + `src/service.ts` |
| Guardrails | `src/guardrails.ts` + `src/service.ts` + `src/http.ts` |
| Parallel Tool Calls | LangChain agent graph `v1` / `v2` + `AGENT_CORE_AGENT_GRAPH_VERSION` + `src/service.ts` |
| Skill System | `src/skills.ts` + `deepagents` skill loader + `GET /skills` / CLI `/skills` |
| Multi-agent / Handoff | `deepagents` task tool + general-purpose subagent + `src/subagents.ts` + `GET /subagents` / CLI `/subagents` |
| Message State | `deepagentsjs`/LangGraph checkpointer + `thread_id` |
| Tool System | `LocalShellBackend` 暴露的 `read_file` / `write_file` / `edit_file` / `glob` / `grep` / `execute` |
| Checkpoint Storage | `@langchain/langgraph-checkpoint-sqlite` + `.agent-core/checkpoints.sqlite` |
| Workspace 安全边界 | `LocalShellBackend.create({ rootDir, virtualMode: true })` |

### 2.2 Harness-as-OS 映射

| OS 概念 | Harness 对应 | 说明 |
|---------|-------------|------|
| 内核 | MessageStore | 消息数组是唯一状态 |
| 进程调度 | Runner / Agent Loop | 驱动 推理 → 工具 → 推理 → ... 循环 |
| 系统调用 | Tool Execution | 模型请求执行工具，harness 代为执行 |
| 权限管理 | Permission Policy | 控制哪些工具可以自动执行 |
| 中断处理 | Hooks | PreToolUse / PostToolUse / PreLLMCall / PostLLMCall |
| 驱动程序 | 具体 Tool 实现 | Read / Write / Bash / Search 等 |
| Shell | CLI REPL / Android UI | 用户和 agent 之间的交互界面 |

### 2.4 最小 HTTP 服务

当前实现在 `src/http.ts` 中提供一个最小 HTTP adapter，用于把 `AgentCoreServiceHarness` 暴露给非 CLI 调用方。

路由约定：

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health` | 健康检查 |
| `GET` | `/skills` | 查看当前 skill source 与已加载 skill metadata |
| `GET` | `/subagents` | 查看 general-purpose subagent 与自定义 subagent 配置 |
| `GET` | `/traces` | 查看最近 trace 事件 |
| `GET` | `/traces/:traceId` | 查看单条 trace 的事件 |
| `POST` | `/threads` | 创建或重置 thread id |
| `POST` | `/runs` | 提交一轮新的用户输入 |
| `POST` | `/runs/stream` | 以 SSE 形式流式返回本轮执行 |
| `POST` | `/resume` | 提交 HITL 审批结果并恢复执行 |
| `POST` | `/resume/stream` | 以 SSE 形式流式恢复被中断线程 |
| `DELETE` | `/threads/:threadId` | 清理 thread 对应的 checkpoint |

协议约束：

- `POST /runs` 请求体最少包含 `input: string`，可选传入 `threadId`
- `POST /resume` 请求体必须包含 `threadId` 和 `resume.decisions`
- `POST /runs/stream` 和 `POST /resume/stream` 返回 `text/event-stream`
- run / resume 响应会返回 `traceId`，并通过 `X-Agent-Core-Trace-Id` 暴露给调用方
- run / resume 响应在发生过上下文压缩后可返回 `contextCompaction`
- SSE 在本轮触发压缩时会发出 `context_compacted`
- guardrail 触发时，普通 JSON 接口返回 `422`，SSE 接口发送 `error` 事件
- `GET /skills` 返回 `{ sources, skills }`，用于调试当前 skill source 解析与 metadata 加载结果
- `GET /subagents` 返回 `{ generalPurposeAgent, sources, subagents }`，用于调试当前 handoff / subagent 配置
- 默认会自动发现工作区内 `.deepagents/skills`，也可通过 `AGENT_CORE_SKILL_SOURCE_PATHS` 追加目录
- skill source 必须位于工作区内；多个 source 出现同名 skill 时，后者覆盖前者
- 默认启用 `deepagents` 的 general-purpose subagent；自定义 subagent 默认从 `.deepagents/subagents/*.md` 发现
- 也可通过 `AGENT_CORE_SUBAGENT_SOURCE_PATHS` 追加 subagent source；多个 source 出现同名 subagent 时，后者覆盖前者
- HTTP 层不重新实现 agent loop，只负责参数校验、消息序列化、线程生命周期和 CORS 处理
- 所有多轮上下文仍由 `thread_id` + SQLite checkpointer 管理

### 2.5 最小 Multi-agent / Handoff

当前 `agent-core` 的 multi-agent / handoff 直接建立在 `deepagents` 的 `task` subagent tool 之上。

约定：

- general-purpose subagent 默认启用
- general-purpose subagent 继承主 agent 的工具和主 skill source
- 自定义 subagent 从工作区内 `.deepagents/subagents/*.md` 发现
- 自定义 subagent 文件正文作为 `systemPrompt`
- frontmatter 当前支持：
  - `name`（可选，默认使用文件名）
  - `description`（必填）
  - `model`（可选）
  - `skills`（可选，解析为工作区内 skill source）
- CLI 使用 `/subagents` 查看当前有效配置
- HTTP 使用 `GET /subagents` 查看当前有效配置

### 2.6 并行 Tool Calls

当前并行 tool call 语义不由 `agent-core` 自己重新实现，而是依赖 LangChain agent graph 的版本化执行模型。

约定：

- `AGENT_CORE_AGENT_GRAPH_VERSION` 控制执行语义
- 默认值为 `v2`
- `v2` 将单轮中的 tool calls 分发到多个 tool node
- `v1` 保留兼容模式，在单个 tool node 中处理单轮 tool calls
- `runOnce()`、`resumeOnce()` 与 streaming 路径都统一透传该配置
- 这样并行执行语义不再依赖底层默认值，而成为 `agent-core` 的显式运行时协议

---

## 3. Agent Core 详细设计

### 3.1 MessageStore

消息数组是 agent 的唯一状态。所有上下文都通过消息传递。

```python
@dataclass
class Message:
    role: Literal["system", "user", "assistant", "tool"]
    content: Optional[str] = None
    tool_calls: Optional[List["ToolCall"]] = None
    tool_call_id: Optional[str] = None
    name: Optional[str] = None

@dataclass
class ToolCall:
    id: str
    name: str
    arguments: Dict[str, Any]

class MessageStore:
    messages: List[Message]

    def append(self, message: Message) -> None: ...
    def get_messages(self) -> List[Message]: ...
    def to_api_format(self) -> List[dict]: ...
    def clear(self) -> None: ...
```

补充规则：

- `assistant` 消息必须先被追加，再执行工具
- 每个工具调用完成后都要追加一条对应的 `tool` 消息
- 单轮多个 tool calls 会生成多条 `tool` 消息

### 3.2 ToolRegistry + `@tool` 装饰器

```python
class PermissionProfile(Enum):
    READ = "read"
    WRITE = "write"
    EXECUTE = "execute"
    NETWORK = "network"

@dataclass
class ToolResult:
    content: str
    structured: Optional[Any] = None
    is_error: bool = False

@dataclass
class ToolDefinition:
    name: str
    description: str
    parameters: Dict[str, Any]
    fn: Callable
    permission_profile: PermissionProfile = PermissionProfile.READ

class ToolRegistry:
    _tools: Dict[str, ToolDefinition]

    def register(self, tool_def: ToolDefinition) -> None: ...
    def get(self, name: str) -> Optional[ToolDefinition]: ...
    def execute(self, name: str, arguments: Dict[str, Any]) -> ToolResult: ...
    def to_api_format(self) -> List[dict]: ...
    def list_tools(self) -> List[str]: ...

def tool(
    name: Optional[str] = None,
    description: Optional[str] = None,
    permission_profile: PermissionProfile = PermissionProfile.READ,
):
    """装饰器：将 Python 函数注册为工具，并从类型标注生成 JSON Schema。"""
    ...
```

使用示例：

```python
@tool(description="读取指定路径的文件内容")
def read_file(path: str) -> ToolResult:
    with open(path) as f:
        text = f.read()
    return ToolResult(content=text)

@tool(description="在指定目录中搜索匹配的文件")
def glob_files(pattern: str, directory: str = ".") -> ToolResult:
    import glob
    matches = glob.glob(pattern, root_dir=directory)
    return ToolResult(content="\n".join(matches), structured=matches)
```

类型标注到 JSON Schema 的转换规则：

| Python 类型 | JSON Schema |
|-------------|-------------|
| `str` | `{"type": "string"}` |
| `int` | `{"type": "integer"}` |
| `float` | `{"type": "number"}` |
| `bool` | `{"type": "boolean"}` |
| `list[str]` | `{"type": "array", "items": {"type": "string"}}` |
| 有默认值的参数 | 不在 `required` 中 |

执行规则：

- 工具函数允许直接返回 `str`，Runner 内部统一规范化为 `ToolResult(content=<str>)`
- 喂回 LLM 的 tool message 只使用 `ToolResult.content`
- `ToolResult.structured` 仅供 CLI 渲染、hooks 和后续 tracing 使用
- `permission_profile` 是默认权限决策的唯一来源，权限系统不应靠工具名硬编码

### 3.3 AgentConfig

```python
@dataclass
class AgentConfig:
    # LLM
    base_url: str = "http://127.0.0.1:1234/v1"
    model: str = "google/gemma-4-26b-a4b"
    api_key: str = "lm-studio"
    temperature: float = 0.7
    max_tokens: int = 4096

    # Agent Loop
    max_turns: int = 10
    system_prompt: str = ""

    # Parser
    response_parser: str = "auto"  # "auto" | "openai" | "gemma4" | "fallback"

    # Permissions
    allowed_tools: Optional[List[str]] = None
    disallowed_tools: Optional[List[str]] = None
    permission_mode: str = "auto"  # "auto" | "always_ask" | "always_allow"
```

---

## 4. Harness Layer 详细设计

### 4.1 Runner（执行编排）

Runner 是 harness 的核心。交互式 REPL 由 `CLIHarness` 负责，Runner 本身只负责单次执行协议。

```python
PermissionResolver = Callable[[ToolDefinition, Dict[str, Any]], "PermissionDecision"]

class Runner:
    def __init__(
        self,
        config: AgentConfig,
        tools: ToolRegistry,
        llm_client: "OpenAICompatibleClient",
        parser: "ResponseParser",
        hooks: Optional["HookRegistry"] = None,
        permission_resolver: Optional[PermissionResolver] = None,
    ): ...

    def run_sync(self, prompt: str) -> "RunResult":
        """同步执行：输入 prompt，返回最终结果。"""
        ...
```

执行协议：

1. 将用户 prompt 追加为一条 `user` message
2. 在每一轮中：
   - 触发 `PRE_LLM_CALL`
   - 调用 `llm_client.chat()`
   - 触发 `POST_LLM_CALL`
   - 用 `parser.parse()` 得到 `ParsedResponse`
   - 追加一条 `assistant` message
3. 若本轮没有 tool calls，返回最终文本结果
4. 若本轮有 tool calls，则按模型返回顺序**串行执行**
5. 对每个 tool call 独立执行：
   - 根据工具名获取 `ToolDefinition`
   - 用 `PermissionPolicy.check()` 做默认权限决策
   - 如果结果为 `ASK`：
     - 有 `permission_resolver`：调用它拿到最终决策
     - 无 `permission_resolver`：立即返回 `permission_required`
   - 触发 `PRE_TOOL_USE`
   - 执行工具；若抛异常，包装为 `ToolResult(is_error=True)`
   - 触发 `POST_TOOL_USE`
   - 追加一条 `tool` message
6. 回到下一轮 LLM
7. 达到 `max_turns` 后返回 `max_turns`

```python
@dataclass
class RunResult:
    messages: List[Message]
    final_text: Optional[str]
    turns_used: int
    tool_calls_made: List[str]
    terminated_reason: str  # "complete" | "max_turns" | "permission_required" | "error"
    pending_tool_call: Optional[ToolCall] = None
    last_error: Optional[str] = None
```

补充规则：

- MVP 支持“单轮多个 tool calls 串行执行”，但不支持并行
- 单个工具失败不会立即终止整个 run，而是作为 error tool result 回传给模型
- 只有遇到 `ASK` 且缺少 `permission_resolver` 时，Runner 才返回 `permission_required`

### 4.2 Hooks 系统

Hooks 是生命周期拦截点，允许在不修改 agent 核心逻辑的情况下插入审计、阻断、参数改写等行为。

```python
class HookEvent(Enum):
    PRE_TOOL_USE = "pre_tool_use"
    POST_TOOL_USE = "post_tool_use"
    PRE_LLM_CALL = "pre_llm_call"
    POST_LLM_CALL = "post_llm_call"
    ON_ERROR = "on_error"

@dataclass
class HookContext:
    event: HookEvent
    tool_call: Optional[ToolCall] = None
    tool_result: Optional[ToolResult] = None
    messages: Optional[List[Message]] = None
    llm_response: Optional["LLMResponse"] = None
    error: Optional[Exception] = None

@dataclass
class HookResult:
    allow: bool = True
    modified_input: Optional[Dict[str, Any]] = None
    inject_messages: List[Message] = field(default_factory=list)

HookFn = Callable[[HookContext], Optional[HookResult]]

class HookRegistry:
    def on(self, event: HookEvent) -> Callable[[HookFn], HookFn]: ...
    def trigger(self, context: HookContext) -> HookResult: ...
```

合并策略：

- 多个 hooks 按注册顺序执行
- `allow` 取逻辑与，只要有一个 hook 拒绝就阻止执行
- `modified_input` 取最后一个非空值
- `inject_messages` 按顺序追加

使用示例：

```python
hooks = HookRegistry()

@hooks.on(HookEvent.PRE_TOOL_USE)
def block_dangerous_commands(ctx: HookContext) -> HookResult:
    if ctx.tool_call and ctx.tool_call.name == "run_command":
        if "rm -rf" in str(ctx.tool_call.arguments):
            return HookResult(allow=False)
    return HookResult(allow=True)

@hooks.on(HookEvent.POST_TOOL_USE)
def log_tool_usage(ctx: HookContext) -> None:
    if ctx.tool_call:
        print(f"[audit] {ctx.tool_call.name} called with {ctx.tool_call.arguments}")
    return None
```

### 4.3 Permission Policy

```python
class PermissionPolicy:
    def __init__(self, config: AgentConfig): ...

    def check(
        self,
        tool_def: ToolDefinition,
        arguments: Dict[str, Any],
    ) -> "PermissionDecision":
        """返回 allow / deny / ask"""
        # 1. disallowed_tools 优先 -> deny
        # 2. allowed_tools 匹配 -> allow
        # 3. permission_mode 显式覆盖：
        #    always_allow -> allow
        #    always_ask -> ask
        # 4. permission_mode = auto 时：
        #    READ -> allow
        #    WRITE / EXECUTE / NETWORK -> ask
        ...

class PermissionDecision(Enum):
    ALLOW = "allow"
    DENY = "deny"
    ASK = "ask"
```

`CLIHarness.ask_permission()` 是 `PermissionResolver` 的一个实现；Android UI 后续只需要提供同样的回调接口。

---

## 5. LLM Client + Response Parser

### 5.1 OpenAICompatibleClient

```python
class OpenAICompatibleClient:
    def __init__(self, base_url: str, api_key: str, model: str): ...

    def chat(
        self,
        messages: List[dict],
        tools: Optional[List[dict]] = None,
        temperature: float = 0.7,
        max_tokens: int = 4096,
    ) -> "LLMResponse":
        """发送 chat completion 请求，返回原始响应。"""
        ...

@dataclass
class LLMResponse:
    content: Optional[str]
    tool_calls: Optional[List[dict]]
    raw: dict
    usage: Optional[dict]
```

### 5.2 ResponseParser

这是适配不同模型 tool call 格式的关键抽象。

```python
class ResponseParser(Protocol):
    def parse(self, response: LLMResponse) -> "ParsedResponse": ...

@dataclass
class ParsedResponse:
    text: Optional[str]
    tool_calls: List[ToolCall]
```

#### OpenAIParser

```python
class OpenAIParser:
    def parse(self, response: LLMResponse) -> ParsedResponse:
        if response.tool_calls:
            calls = [
                ToolCall(
                    id=tc["id"],
                    name=tc["function"]["name"],
                    arguments=json.loads(tc["function"]["arguments"]),
                )
                for tc in response.tool_calls
            ]
            return ParsedResponse(text=response.content, tool_calls=calls)
        return ParsedResponse(text=response.content, tool_calls=[])
```

#### Gemma4Parser

处理 Gemma 4 原生格式。当 LM Studio 的 mlx-lm 后端没有正确解析 `tool_calls` 时，原始格式会出现在 `content` 中。

MVP 范围约束：

- 仅支持**扁平参数对象**
- 参数值仅支持 `str / int / float / bool`
- 不支持嵌套对象、数组或复杂转义字符串
- 因此第一版内置工具参数设计必须尽量保持标量化

示例：

```
<|tool_call>call:get_weather{location:<|"|>London<|"|>,units:<|"|>celsius<|"|>}<tool_call|>
```

```python
class Gemma4Parser:
    TOOL_CALL_PATTERN = re.compile(
        r'<\|tool_call>call:(\w+)\{(.*?)\}<tool_call\|>',
        re.DOTALL,
    )
    STRING_DELIM = '<|"|>'

    def parse(self, response: LLMResponse) -> ParsedResponse:
        if response.tool_calls:
            return OpenAIParser().parse(response)

        content = response.content or ""
        matches = self.TOOL_CALL_PATTERN.findall(content)
        if not matches:
            return ParsedResponse(text=content, tool_calls=[])

        calls = []
        for func_name, raw_args in matches:
            arguments = self._parse_gemma4_args(raw_args)
            calls.append(
                ToolCall(
                    id=f"call_{uuid4().hex[:8]}",
                    name=func_name,
                    arguments=arguments,
                )
            )

        text = self.TOOL_CALL_PATTERN.sub("", content).strip() or None
        return ParsedResponse(text=text, tool_calls=calls)

    def _parse_gemma4_args(self, raw: str) -> Dict[str, Any]:
        """仅解析扁平 key/value 参数对象。"""
        ...
```

#### ContentFallbackParser

```python
class ContentFallbackParser:
    def parse(self, response: LLMResponse) -> ParsedResponse:
        content = response.content or ""
        # 尝试匹配 ```json ... ``` 或裸 JSON
        # 查找类似 {"name": "tool_name", "arguments": {...}} 的结构
        ...
```

#### AutoParser

```python
class AutoParser:
    def __init__(self):
        self.parsers = [OpenAIParser(), Gemma4Parser(), ContentFallbackParser()]

    def parse(self, response: LLMResponse) -> ParsedResponse:
        for parser in self.parsers:
            result = parser.parse(response)
            if result.tool_calls:
                return result
        return ParsedResponse(text=response.content, tool_calls=[])
```

---

## 6. Interface Layer（CLI Harness）

### 6.1 CLI REPL

用 `rich` 渲染的交互式命令行：

```python
class CLIHarness:
    def __init__(self, runner: Runner): ...

    def start(self) -> None:
        """启动 REPL 循环"""
        # 1. 显示欢迎信息和已加载的工具列表
        # 2. 循环：
        #    a. 读取用户输入
        #    b. 调用 runner.run_sync(prompt)
        #    c. 渲染工具调用、中间结果和最终回复
        # 3. 特殊命令：/quit, /tools, /history, /config
        ...

    def render_tool_call(self, tool_name: str, args: Dict[str, Any]) -> None: ...
    def render_tool_result(self, tool_name: str, result: ToolResult) -> None: ...

    def ask_permission(
        self,
        tool_def: ToolDefinition,
        args: Dict[str, Any],
    ) -> PermissionDecision:
        """作为 PermissionResolver 传给 Runner。"""
        ...
```

### 6.2 CLI 渲染目标

```
Agent Core v0.1 | Model: gemma-4-26B-A4B-it | Tools: 5 loaded

You: 帮我看看当前目录有哪些 Python 文件

Tool Call: glob_files
pattern="**/*.py"
directory="."

Result:
src/main.py
src/agent.py
tests/test_agent.py

当前目录下有 3 个 Python 文件：
- src/main.py
- src/agent.py
- tests/test_agent.py
```

---

## 7. 文件结构

```
agent-core/
├── docs/
│   ├── specs/
│   ├── changes/
│   └── reviews/
├── src/
│   └── agent_core/
│       ├── __init__.py
│       ├── core/
│       │   ├── __init__.py
│       │   ├── message.py          ← Message, ToolCall, MessageStore
│       │   ├── tool.py             ← ToolDefinition, ToolResult, PermissionProfile, ToolRegistry, @tool
│       │   └── config.py           ← AgentConfig
│       ├── harness/
│       │   ├── __init__.py
│       │   ├── runner.py           ← Runner, RunResult, PermissionResolver
│       │   ├── hooks.py            ← HookEvent, HookRegistry
│       │   └── permission.py       ← PermissionPolicy
│       ├── llm/
│       │   ├── __init__.py
│       │   ├── client.py           ← OpenAICompatibleClient, LLMResponse
│       │   └── parsers/
│       │       ├── __init__.py
│       │       ├── base.py         ← ResponseParser, ParsedResponse
│       │       ├── openai_parser.py
│       │       ├── gemma4_parser.py
│       │       ├── fallback_parser.py
│       │       └── auto_parser.py
│       └── interface/
│           ├── __init__.py
│           └── cli.py              ← CLIHarness
├── tools/
│   ├── __init__.py
│   ├── filesystem.py               ← read_file, write_file, glob_files
│   ├── shell.py                    ← run_command
│   └── search.py                   ← grep_search
├── tests/
│   ├── test_message.py
│   ├── test_tool_registry.py
│   ├── test_parsers.py
│   ├── test_permission.py
│   └── test_runner.py
├── main.py
└── pyproject.toml
```

---

## 8. 内置工具集（第一版）

| 工具名 | 功能 | 参数 | `permission_profile` |
|--------|------|------|----------------------|
| `read_file` | 读取文件内容 | `path: str` | `READ` |
| `write_file` | 写入文件 | `path: str, content: str` | `WRITE` |
| `glob_files` | 搜索文件 | `pattern: str, directory: str = "."` | `READ` |
| `grep_search` | 搜索文件内容 | `pattern: str, path: str = ".", type: str = None` | `READ` |
| `run_command` | 执行 shell 命令 | `command: str, timeout: int = 30` | `EXECUTE` |

补充约定：

- 第一版内置工具参数刻意保持**标量化**，以适配 Gemma4Parser 的 MVP 能力边界
- 所有内置工具最终都返回 `ToolResult`
- 喂回模型的内容统一使用 `ToolResult.content`

---

## 9. Gemma 4 工具调用：已知问题与应对

### 9.1 现状（2026-04-05）

| 推理后端 | Gemma 4 Tool Use 状态 |
|---------|----------------------|
| LM Studio (mlx-lm) | `tool_calls` 不被解析，原始格式出现在 `content` 中 |
| Ollama v0.20 | 存在 parser 兼容问题 |
| vLLM | 可工作，需 `--tool-call-parser gemma4` |
| llama.cpp | 需特定工具调用支持版本 |

### 9.2 框架应对策略

1. **AutoParser 作为默认**：先尝试 OpenAI 标准字段，再尝试 Gemma 4 格式解析，最后兜底
2. **Gemma4Parser 独立实现**：第一版仅支持扁平参数对象的 `<|tool_call>` 解析
3. **可配置切换**：`AgentConfig.response_parser` 可强制指定 parser
4. **面向未来**：当推理后端修复 Gemma 4 支持后，OpenAIParser 自动生效，无需改代码

### 9.3 Gemma 4 Tool Call 格式参考

工具定义：

```
<|tool>{"name": "read_file", "description": "...", "parameters": {...}}<tool|>
```

模型输出的工具调用：

```
<|tool_call>call:read_file{path:<|"|>/tmp/test.txt<|"|>}<tool_call|>
```

工具结果回传：

```
<|tool_response>response:read_file{content:<|"|>file contents here<|"|>}<tool_response|>
```

### 9.4 MVP 边界

- 仅保证扁平参数对象能被 Gemma4Parser 正确解析
- 嵌套对象、数组、复杂转义字符串不属于第一版承诺范围
- 需要复杂结构化参数时，优先使用支持原生 `tool_calls` 的模型路径

### 9.5 替代模型兼容性

框架不绑定 Gemma 4。以下模型在 LM Studio 中通常具备更稳的原生 `tool_calls` 支持：

- Qwen 2.5 / Qwen 3
- Llama 3.1 / 3.2
- Mistral

---

## 10. 跨平台移植指南（TypeScript / deepagentsjs → Kotlin）

### 10.1 哪些可以直接映射

| 当前 TypeScript 抽象 | Kotlin 对应 |
|----------------------|-------------|
| `AgentCoreServiceHarness.runOnce()` | `AgentService.runOnce()` |
| `AgentCoreServiceHarness.resumeOnce()` | `AgentService.resumeOnce()` |
| `HITLRequest` / `HITLResponse` | `data class HITLRequest` / `HITLResponse` |
| `ActionRequest` / `ReviewConfig` | 对应 `data class` |
| `thread_id` 语义 | conversation / session id |
| SQLite checkpointer | Room / SQLite / SQLDelight 持久化 |
| OpenAI 兼容 chat client | OkHttp / Ktor HTTP client |

### 10.2 需要重新设计的部分

| 能力 | TypeScript 当前实现 | Kotlin 方向 |
|------|---------------------|------------|
| 本地工具执行 | `LocalShellBackend` | Android 沙箱 / app 内 capability bridge |
| CLI 渲染 | `AgentCoreCli` | Android UI / service 层回调 |
| Permission 交互 | 终端 prompt | Dialog / sheet / foreground approval flow |
| Session 文件 | `.agent-core/session.json` | SharedPreferences / DataStore / SQLite |
| Checkpointer | `@langchain/langgraph-checkpoint-sqlite` | Kotlin 侧自定义 checkpoint adapter |

### 10.3 必须保持一致的协议

- OpenAI 兼容 chat completion 请求/响应格式
- `thread_id` 作为多轮会话主键的语义
- HITL interrupt payload 的结构
- `approve` / `edit` / `reject` 三种审批决策语义
- tool message 与 assistant message 的追加顺序
- 工作区边界和默认权限策略

---

## 11. 第一版范围（MVP）

### 包含

- `createAgentRuntime()` 运行时组装
- `AgentCoreServiceHarness.runOnce()` / `resumeOnce()`
- 最小 HTTP 服务（`GET /health`、`POST /threads`、`POST /runs`、`POST /resume`、`DELETE /threads/:threadId`）
- HTTP SSE streaming（`POST /runs/stream`、`POST /resume/stream`）
- 本地 tracing / observability（`traceId`、JSONL trace log、`GET /traces`、`GET /traces/:traceId`）
- Context compaction（基于 `deepagents` summarization middleware，结果与 trace 可观测）
- 规则型 guardrails（input/output 长度限制、blocked term 校验、结构化 422 / SSE error）
- 并行 tool call 语义（LangChain agent graph `v1` / `v2`，默认 `v2`）
- Skill system（工作区内 skill source 发现、`deepagents` skill loader 集成、CLI / HTTP 可见）
- Multi-agent / Handoff（general-purpose subagent + 工作区自定义 subagent 发现 + CLI / HTTP 可见）
- SQLite 会话 checkpoint 持久化
- `session.json` thread 恢复
- CLI REPL
- HITL approve / edit / reject 流程
- `LocalShellBackend` 提供的文件系统与命令工具
- `README.md` quickstart
- 单元测试（settings / hitl / persistence / service harness / http）
- 真实 runtime 集成烟测（临时工作区 + HTTP service）

### 不包含（后续版本）

- Kotlin Android 实现

---

## 12. 验证方式

1. `npm run typecheck`
   验证 TypeScript 类型闭环
2. `npm test`
   验证 HITL、settings、persistence、service harness、http 和 runtime smoke 测试
3. `npm run build`
   验证编译产物可生成
4. `printf '/quit\n' | npm run dev`
   验证 CLI 可以正常启动并退出
5. `npm run serve`
   启动最小 HTTP 服务
6. `curl http://127.0.0.1:8787/health`
   验证 HTTP 服务健康检查
7. `curl http://127.0.0.1:8787/traces?limit=10`
   验证 trace 查询接口
8. `curl http://127.0.0.1:8787/skills`
   验证 skill source 发现与 metadata 暴露接口
9. `curl http://127.0.0.1:8787/subagents`
   验证 general-purpose subagent 与自定义 subagent 暴露接口
10. `curl -X POST http://127.0.0.1:8787/runs -H 'Content-Type: application/json' -d '{"input":"this input is intentionally too long for a tiny guardrail setup"}'`
   在配置较小 `AGENT_CORE_MAX_INPUT_CHARS` 时验证 guardrail 返回 `422`
11. `curl -N -X POST http://127.0.0.1:8787/runs/stream -H 'Content-Type: application/json' -d '{"input":"hi"}'`
   验证 SSE streaming 路由可工作
12. 在较小 `AGENT_CORE_CONTEXT_WINDOW_TOKENS_HINT` 配置下连续运行多轮对话
    验证响应中的 `contextCompaction`、SSE `context_compacted` 和 trace `context_compacted`
13. `node dist/src/index.js </dev/null`
   验证非交互 EOF 场景下能平稳退出
14. 重复启动两次 CLI
   验证 `.agent-core/session.json` 和 `.agent-core/checkpoints.sqlite` 生效，thread 能续跑
