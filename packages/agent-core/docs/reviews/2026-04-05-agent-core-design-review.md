# Agent Core + Harness 设计评审

- 评审对象：`docs/specs/2026-04-05-agent-core-design-spec.md`
- 评审日期：2026-04-05
- 说明：本评审基于 2026-04-05 初稿；若 spec 后续按本评审修订，行号和适用范围可能变化
- 评审结论：方向正确，但当前版本还不是“可直接编码”的 spec；建议先收口执行协议，再进入实现

## Findings

### [P1] Python 版本约束与示例 API 语法冲突

spec 声明第一版支持 Python 3.9+，但文中核心接口大量使用了 3.10 才支持的 `X | None` 联合类型语法。按当前写法实现，代码会在 3.9 直接语法报错，和环境约束相冲突。

证据：

- 第 1.2 节声明 Python 版本为 3.9+：第 31 行
- `Message` 使用 `str | None` / `list[ToolCall] | None`：第 115-118 行
- `Runner.__init__` 使用 `HookRegistry | None`：第 225 行
- `OpenAICompatibleClient.chat` 使用 `list[dict] | None`：第 342 行

影响：

- 代码模板无法直接拷贝为实现
- 测试环境、类型检查和运行环境会产生不一致

建议：

- 二选一，不要混用：
  - 方案 A：把最低版本改成 Python 3.10+
  - 方案 B：保留 Python 3.9+，把类型示例统一改为 `Optional[...]` / `Union[...]`

### [P1] `PermissionDecision.ASK` 在 `run_sync()` 主路径中没有落地协议

spec 定义了 `ASK` 权限决策，也把 `write_file` / `run_command` 设为默认需要确认，但 `Runner.run_sync()` 没有接收权限确认回调，也没有“暂停并等待确认”的执行协议。当前只有 CLI 层有 `ask_permission()`，这会导致同步 API 在非交互调用场景下行为未定义。

证据：

- `Runner` 只有 `config/tools/hooks`，没有 permission callback：第 223-233 行
- PermissionPolicy 会返回 `ASK`：第 319-329 行
- CLIHarness 独有 `ask_permission()`：第 495-497 行
- 默认工具权限明确要求确认：第 587-590 行

影响：

- `run_sync()` 无法作为通用 SDK API 使用
- 后续移植到 Kotlin 时，权限交互只能耦合在 UI 层，Runner 无法复用

建议：

- 给 Runner 增加显式权限确认接口，例如：

```python
PermissionResolver = Callable[[str, dict], PermissionDecision]

class Runner:
    def __init__(
        self,
        config: AgentConfig,
        tools: ToolRegistry,
        hooks: HookRegistry | None = None,
        permission_resolver: PermissionResolver | None = None,
    ): ...
```

- 当策略返回 `ASK` 且未提供 `permission_resolver` 时，`run_sync()` 应终止并返回 `terminated_reason="permission_required"`，而不是隐式 allow/deny
- CLI REPL 只是 `permission_resolver` 的一个实现，不应是唯一实现

### [P1] 权限默认值无法通过当前 ToolDefinition 通用表达

spec 同时要求“最小抽象”和“按工具默认权限自动处理”，但当前 `ToolDefinition` 只有 `name/description/parameters/fn`，没有任何安全等级、是否有副作用、默认权限之类的元数据。这样一来，`permission_mode="auto"` 只能靠工具名硬编码，无法成为稳定的跨平台协议。

证据：

- `ToolDefinition` 字段只有四个：第 140-145 行
- `AgentConfig` 中有 `permission_mode="auto"`：第 209-211 行
- `PermissionPolicy` 只描述 allowed/disallowed/default mode：第 319-324 行
- 默认工具权限要求按工具类型区分：第 587-590 行

影响：

- 权限策略和具体工具名耦合
- 新增工具、替换工具集、迁移到 Kotlin 时都要重复写硬编码

建议：

- 为 `ToolDefinition` 增加最小权限元数据：

```python
@dataclass
class ToolDefinition:
    name: str
    description: str
    parameters: dict[str, Any]
    fn: Callable
    permission_profile: Literal["read", "write", "execute", "network"] = "read"
```

- `PermissionPolicy` 基于 `permission_profile` 做默认决策，而不是依赖工具名白名单

### [P1] 多工具调用的数据结构存在，但执行语义未定义

`Message.tool_calls` 和 `ParsedResponse.tool_calls` 都是列表，这说明单轮多个工具调用是被允许的；但 Runner 流程、HookContext 和 CLI 渲染都按“单个工具调用”来写，导致关键行为缺失：多个工具是顺序执行还是拒绝？每个工具调用是否分别做权限检查、分别追加 tool message？

证据：

- `Message.tool_calls` 为 `list[ToolCall]`：第 116 行
- `ParsedResponse.tool_calls` 为 `list[ToolCall]`：第 368 行
- loop 文字描述按单个 tool call 写：第 242-244 行
- HookContext 只有单个 `tool_name/tool_input/tool_output`：第 273-279 行

影响：

- OpenAI 兼容模型如果一次返回多个 tool calls，Runner 行为未定义
- hook 和权限检查无法稳定复用

建议：

- 在 MVP 明确采用“单轮多调用，按返回顺序串行执行”的协议
- 每个 tool call 单独执行以下步骤：
  - 权限检查
  - `PRE_TOOL_USE`
  - 工具执行
  - `POST_TOOL_USE`
  - 追加一条对应的 `tool` message
- 如果任一工具被拒绝，需明确后续策略：
  - 推荐：为该 tool call 生成一条 error tool message，再继续下一轮 LLM 推理

### [P1] Gemma4Parser 的承诺范围大于当前可实现范围

spec 把 Gemma 4 作为首要适配模型，并宣称 Gemma4Parser 可以“完整支持”原生 tool call 格式；但当前设计只给出了基于正则和扁平 key/value 解析的方向，这不足以稳定覆盖嵌套对象、数组、字符串中包含分隔符或 `}` 的场景。

证据：

- 首要适配 Gemma 4：第 34 行
- 工具 schema 支持数组等更通用类型：第 176-185 行
- Gemma4Parser 用最短匹配正则抓 `{...}`：第 398-400 行
- `_parse_gemma4_args()` 描述只覆盖裸 key 和基础 value：第 429-432 行
- 第 9.2 节声称“完整支持 `<|tool_call>` 格式解析”：第 607-608 行

影响：

- 复杂工具参数在 Gemma 4 路径下会出现解析失败或截断
- “Gemma 4 首要适配”很容易变成只对 demo 工具成立

建议：

- MVP 先收窄承诺范围，写清：
  - Gemma4Parser 第一版只支持扁平参数对象
  - 参数值仅支持 `str/int/float/bool`
  - 复杂嵌套对象和数组不作为 Gemma 4 MVP 目标
- 如果未来要支持完整语法，再单独设计基于 tokenizer/状态机的 parser，而不是继续堆正则

### [P2] 工具返回值契约前后不一致

当前 spec 有的地方把工具输出当 `str`，有的地方又示例返回 `list[str]`。如果不先统一，Runner、hook、日志、CLI 渲染和 message 序列化都会出现各自处理各自的情况。

证据：

- `ToolRegistry.execute()` 返回 `str`：第 152 行
- `glob_files()` 示例返回 `list[str]`：第 171-173 行
- `HookContext.tool_output` 是 `str | None`：第 277 行
- `CLIHarness.render_tool_result()` 参数为 `str`：第 493 行

影响：

- 工具实现者不知道该返回原始结构化数据还是字符串
- 输出展示和喂回模型的内容会产生隐式转换

建议：

- 采用统一的 `ToolResult` 协议：

```python
@dataclass
class ToolResult:
    content: str
    structured: Any | None = None
    is_error: bool = False
```

- Runner 追加给模型的仍然是 `content`
- CLI / hooks / tracing 可按需使用 `structured`

## 可实现修订建议

下面是一版更适合直接进入编码的最小修订方案。

### 1. 先固定 Python 基线

- 如果你想省实现成本，直接把最低版本改成 Python 3.10+
- 如果必须兼容系统自带 Python 3.9，就把文中所有类型声明回退为 3.9 兼容写法

### 2. 明确 Runner 的执行协议

建议把 Runner 的最小行为写成下面这样：

1. 发送消息到 LLM
2. 解析为 `ParsedResponse`
3. 若无 tool calls，返回 final text
4. 若有 tool calls，按顺序逐个处理
5. 每个 tool call 执行：
   - `PermissionPolicy.check()`
   - 如为 `ASK`，调用 `permission_resolver`
   - 触发 `PRE_TOOL_USE`
   - 执行工具
   - 捕获异常并包装成 error result
   - 触发 `POST_TOOL_USE`
   - 追加 tool message
6. 回到下一轮 LLM
7. 超过 `max_turns` 时返回 `terminated_reason="max_turns"`

### 3. 把权限模型改成“工具元数据驱动”

最小落地版本：

```python
class PermissionProfile(Enum):
    READ = "read"
    WRITE = "write"
    EXECUTE = "execute"
    NETWORK = "network"
```

默认策略：

- `READ` -> auto allow
- `WRITE` -> ask
- `EXECUTE` -> ask
- `NETWORK` -> ask

这样 CLI 和 Kotlin UI 只需要实现“如何确认”，不用重写“哪些要确认”。

### 4. 明确多工具调用只做串行，不做并行

MVP 不做并行工具调用，但必须支持模型一次返回多个 calls。

建议在 spec 中明确：

- 单轮多个 tool calls 按返回顺序串行执行
- 每个工具调用单独产出一条 tool message
- 单个工具失败不必立即终止整个 run，可把错误作为 tool result 返回给模型

### 5. 收窄 Gemma 4 MVP 范围

为了让第一版真的能交付，建议这样写：

- Gemma4Parser 第一版只支持扁平参数对象
- 第一版内置工具参数尽量限制为简单标量
- 复杂结构化参数优先走 OpenAI 原生 `tool_calls` 路径的模型

这会比现在“宣称完整支持，实际只覆盖简单情况”更稳。

### 6. 统一工具结果模型

建议把工具输出统一成：

```python
@dataclass
class ToolResult:
    content: str
    structured: Any | None = None
    is_error: bool = False
```

对应落地规则：

- 工具函数可以返回 `ToolResult`
- 为了兼容简单工具，也允许直接返回 `str`
- Runner 内部统一规范化为 `ToolResult`
- 喂回模型时只发送 `content`

## 建议的 spec 修订优先级

1. 先修 Python 版本和类型语法冲突
2. 再补 Runner 的权限确认协议
3. 然后给 ToolDefinition 增加权限元数据
4. 再定义多工具调用和工具异常的执行语义
5. 最后收窄 Gemma 4 MVP 范围并统一 ToolResult

## 结论

这份设计的模块划分已经足够清楚，真正阻碍实现的不是“还缺更多类”，而是几个关键协议还没有闭环：

- 权限如何进入 Runner
- 多工具调用如何执行
- Gemma 4 到底保证支持到什么程度
- 工具结果到底是什么形状

把这些协议先定死，这份 spec 就能从“方向正确”进入“可以直接编码”。
