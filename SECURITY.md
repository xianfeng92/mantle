# Security Policy

`Mantle Monorepo` 涉及本地 AI agent、桌面权限、本地 HTTP 服务和工具执行能力。安全问题请负责任地私下披露，不要先公开发 issue。

## Reporting a Vulnerability

如果你发现了安全问题，请不要先创建公开 issue。请通过私下渠道联系维护者，并尽量提供：

- 受影响的组件
  - `apps/mantle`
  - `packages/agent-core`
  - 或两者协作边界
- 复现步骤
- 影响范围
- 可能的利用前提
- 如有可能，附带修复建议

如果当前还没有单独的安全邮箱，建议先通过私下可达渠道联系仓库维护者，再决定是否公开披露。

## Scope

我们特别关心以下几类问题：

- 未授权工具执行
- 本地文件越权访问
- prompt injection 导致的危险动作执行
- `localhost` bridge 被外部页面或恶意进程滥用
- 权限提升或权限绕过
- token / credential 泄漏
- 桌面控制能力被意外暴露给非预期调用方

## Project-Specific Risks

### `apps/mantle`

`Mantle` 可能涉及以下高权限能力：

- Accessibility
- Screen Recording
- Notifications
- 全局热键
- 本地自动化 / 桌面控制

相关改动需要特别关注：

- 是否真的需要该权限
- 是否可以默认关闭
- 是否有清晰的用户提示和开关
- 是否能在日志中审计关键动作

### `packages/agent-core`

`agent-core` 是本地 agent runtime，风险主要集中在：

- shell / file tools
- tool orchestration
- HTTP/SSE endpoints
- long-running daemon / session state
- memory / persistence / traces

请重点检查：

- 未认证或弱认证接口
- 来自模型输出的危险参数直通
- 路径遍历、命令注入、任意文件写入
- 敏感日志落盘

## Localhost and Browser Boundary

本仓库中的部分能力会通过本地 HTTP 服务协作。凡是浏览器页面、扩展、bookmarklet 或桌面端会访问 `localhost` 的地方，都应特别注意：

- 请求来源校验
- token 校验
- CORS / preflight 配置
- 默认关闭不必要的公开端点

不要假设“只监听 `127.0.0.1`”就天然安全。

## Safe Contribution Guidelines

提交安全相关改动时，建议一并包含：

- 威胁模型或简短风险说明
- 负向测试或最小复现用例
- 回归风险说明
- 用户侧行为变化说明

## Supported Security Posture

当前仓库仍处于积极演进阶段，接口和安全边界可能继续调整。我们会优先修复高影响问题，尤其是涉及：

- 未授权执行
- 数据泄漏
- 权限绕过
- 本地高权限能力误暴露
