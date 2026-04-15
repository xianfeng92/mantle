# Agent Core Guardrails 实现说明

## 本次实现目标

为 `agent-core` 增加一层最小但实用的 guardrails：

- 在 service 边界统一校验 input / output
- 普通 JSON 接口返回结构化 `422`
- SSE 在流式路径中输出结构化 `error` 事件
- guardrail 命中结果写入本地 trace

## 本次改动

- `src/guardrails.ts`
  - 新增 `DefaultGuardrails`
  - 定义 `GuardrailViolationError`
  - 提供 input / output / message 级校验
- `src/settings.ts`
  - 新增 `AGENT_CORE_MAX_INPUT_CHARS`
  - 新增 `AGENT_CORE_MAX_OUTPUT_CHARS`
  - 新增 `AGENT_CORE_BLOCKED_INPUT_TERMS`
  - 新增 `AGENT_CORE_BLOCKED_OUTPUT_TERMS`
- `src/agent.ts`
  - runtime 创建时注入 `guardrails`
- `src/service.ts`
  - 普通 run / resume 路径接入 input / output 校验
  - streaming 路径在文本增量和工具输出上做增量校验
  - guardrail 触发时记录 `guardrail_triggered` trace
- `src/http.ts`
  - 普通 JSON run / resume 的 guardrail 错误返回 `422`
  - SSE guardrail 错误以 `event: error` 返回结构化 payload
- `src/cli.ts`
  - guardrail 触发时不退出进程，只提示用户
- `tests/guardrails.test.ts`
  - 覆盖 guardrails 模块本身
- `tests/service.test.ts`
  - 覆盖 input / output guardrail 拦截
- `tests/http.test.ts`
  - 覆盖 `422` 错误和 SSE guardrail error 语义

## 当前规则模型

当前 guardrails 是规则型 MVP，不依赖第二个模型：

- 最大输入字符数
- 最大输出字符数
- blocked input terms
- blocked output terms

其中 blocked terms 使用大小写不敏感的子串匹配。

## 设计取舍

- guardrails 放在 `service` 层，而不是只放在 HTTP 层
  - 这样 CLI、HTTP、后续 app adapter 都能共享同一套验证
- streaming 路径选择“命中后终止并返回 `error` 事件”
  - 不尝试对已输出内容做回滚
- 先做规则型 guardrails
  - 后续如果需要再引入更复杂的 policy engine 或模型审查

## 验证结果

已执行：

- `npm run typecheck`
- `npm test`
- `npm run build`
- `printf '/quit\n' | npm run dev`

结果：

- 类型检查通过
- 30 个 TypeScript 测试全部通过
- 构建通过
- CLI 可以正常启动并退出
