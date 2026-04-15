# Agent Core spec 修订说明

## 本次修订目标

根据 `docs/reviews/2026-04-05-agent-core-design-review.md`，将初稿 spec 从“方向正确”修订为“可直接进入编码”的版本。

## 已完成修订

- 将 spec 状态从 `draft` 调整为 `ready`
- 保留 Python 3.9+ 约束，并统一为 3.9 兼容类型注解写法
- 明确 `Runner` 的依赖和执行协议：
  - 注入 `llm_client`
  - 注入 `parser`
  - 注入 `permission_resolver`
  - 定义 `permission_required` 终止路径
- 明确多工具调用为“单轮串行执行”，不做并行
- 引入 `ToolResult`，统一工具输出契约
- 引入 `PermissionProfile`，让默认权限决策由工具元数据驱动
- 收窄 Gemma4Parser MVP 范围为“扁平参数对象”
- 更新 CLI、文件结构、MVP 范围和验证方式，使其与新协议一致

## 当前结论

修订后的 spec 可以作为第一版实现输入使用，后续编码应以该文档中的执行协议为准。
