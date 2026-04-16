---
tasks: []
---

# Heartbeat Tasks

This file drives the heartbeat worker. Each entry in `tasks:` is a scheduled
proactive task that runs on its own clock, with results dispatched to the
[Returns Plane](docs/specs/2026-04-16-returns-plane-spec.md).

See the spec at [docs/specs/2026-04-16-heartbeat-spec.md](docs/specs/2026-04-16-heartbeat-spec.md)
for field semantics.

## Example tasks (commented out by default)

Copy any of these into the `tasks:` array above to enable.

```yaml
# Every morning, pull together a short briefing of what to focus on today.
- id: morning-brief
  schedule: "daily 07:00"
  handler: agent-run
  prompt: |
    今天是周几？列 3 件今天最该关注的事，基于我 workspace 里的项目文件和近期
    改动。保持到 80 个中文字以内。

# Every Friday afternoon, summarise the week's git log.
- id: weekly-repo-review
  schedule: "weekly fri 17:00"
  handler: agent-run
  prompt: |
    扫 workspace 下的 git log，挑 3 条本周最值得周五回顾的改动。
  tags: [weekly, repo]

# Quick poll — useful when prototyping a flow end-to-end.
- id: dev-ping
  schedule: "every 10 minutes"
  handler: agent-run
  enabled: false
  prompt: "ping"
```

## Schedule formats

- `daily HH:MM` — once per day at local time
- `weekly DAY HH:MM` — `DAY ∈ mon|tue|wed|thu|fri|sat|sun`
- `every N minutes` / `every N hours` — fixed interval

## Handlers

- `agent-run` — runs `prompt` through a headless agent (no human in the loop).
  Sensitive tool calls cause the task to fail; the error shows up in the Inbox.
