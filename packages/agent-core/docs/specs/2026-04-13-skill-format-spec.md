---
title: Standardized Skill Format v2
status: ready
owner: claude
created: 2026-04-13
updated: 2026-04-20
implements: []
reviews: []
---

# Standardized Skill Format v2

## Motivation

Inspired by the OpenClaw ecosystem's `SKILL.md` convention, this spec standardizes
how skills are defined in agent-core. The goal is to make skills independently
distributable and community-contributable.

## SKILL.md Format

Each skill lives in its own directory under a skill source path. The directory
must contain a `SKILL.md` file with YAML frontmatter + Markdown body.

### Frontmatter Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Unique identifier (kebab-case) |
| `description` | string | yes | One-line description |
| `version` | string | no | SemVer (e.g., `1.0.0`) |
| `author` | string | no | Author name or handle |
| `license` | string | no | SPDX identifier (e.g., `MIT`) |
| `tags` | string (CSV) | no | Comma-separated tags for discovery |
| `requires_tools` | string (CSV) | no | Tools the skill depends on |
| `allowed_tools` | string (space-separated) | no | Tool whitelist when active |
| `execution_mode` | `inline` \| `fork` | no | Default: `inline` |
| `compatibility.min_context` | number | no | Minimum context window |
| `compatibility.models` | string | no | Glob patterns for compatible models |

### Body

The Markdown body is injected into the agent's system prompt when the skill
is activated. It should contain:

1. **Instructions** — What the skill does and how to use it
2. **Examples** (optional) — Few-shot demonstrations
3. **Constraints** (optional) — Limitations and edge cases

### Example

```yaml
---
name: code-review
description: Review code changes for bugs, style, and best practices
version: 1.0.0
author: mantle-community
license: MIT
tags: code, review, quality
requires_tools: execute, read_file
allowed_tools: read_file execute glob grep
execution_mode: inline
---

# Code Review

## Instructions
You are a code review assistant. When the user asks you to review code:
1. Read the relevant files using read_file
2. Analyze for bugs, style issues, and potential improvements
3. Provide structured feedback with file:line references

## Output Format
Use this structure:
- **Critical**: Must-fix issues
- **Warning**: Should-fix issues
- **Suggestion**: Nice-to-have improvements
```

## Backward Compatibility

- All new fields are optional
- Skills with only `name` and `description` continue to work
- Unknown frontmatter keys are preserved in the `metadata` map

## API

`GET /skills` returns the full metadata including v2 fields:

```json
{
  "sources": [...],
  "skills": [
    {
      "name": "code-review",
      "description": "Review code changes...",
      "version": "1.0.0",
      "author": "mantle-community",
      "tags": ["code", "review", "quality"],
      "requiresTools": ["execute", "read_file"],
      "allowedTools": ["read_file", "execute", "glob", "grep"],
      "executionMode": "inline"
    }
  ]
}
```

## Implementation notes

Implemented today:
- `src/skills.ts` resolves skill source directories inside the workspace and lists per-skill `SKILL.md` files
- The loader returns core fields such as `name`, `description`, `path`, `sourcePath`, `license`, `metadata`, and `allowedTools`
- Several v2 fields are already extracted from frontmatter metadata: `version`, `author`, `tags`, `requiresTools`, and `executionMode`
- Unknown frontmatter keys are preserved in the `metadata` bag, which matches the backward-compatibility goal

Not fully implemented yet:
- `compatibility.min_context` and `compatibility.models` are not normalized into a structured compatibility object; the runtime still exposes only the legacy `compatibility?: string`
- The HTTP `GET /skills` response in `src/http.ts` does not yet serialize the v2 fields shown in the API example (`version`, `author`, `tags`, `requiresTools`, `executionMode`)
- The spec's full v2 API contract is therefore only partially implemented even though the loader understands several of the new frontmatter fields
