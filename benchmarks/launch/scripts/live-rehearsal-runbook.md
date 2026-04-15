# Live Rehearsal Runbook

Use this runbook before recording public GIFs or video.

## Required Rehearsals

1. Real text selection -> rewrite
2. Real sandbox downloads -> organize + rollback
3. Real context snapshot -> todo

## Before You Start

- Confirm LM Studio is running with the intended model.
- Confirm `agent-core` is reachable at `/health`.
- Confirm the app is connected to the local backend.
- Confirm the demo machine has the expected sample files and clean UI state.

## Rehearsal Steps

### 1. Selection -> Rewrite

- Select text in a real app.
- Trigger Mantle via the intended entry point.
- Ask for rewrite, summary, or reply draft.
- Confirm the output matches the README workflow promise.

### 2. Downloads -> Organize + Rollback

- Reset the sandbox downloads folder.
- Ask Mantle to inspect and propose a move plan.
- Confirm the plan.
- Verify the audit trail and move log.
- Roll the moves back.
- Check that the files return to their original locations.

### 3. Context -> Todo

- Prepare the target app/window/files.
- Trigger the context workflow from the intended entry point.
- Confirm the todo list is grounded in the visible context and not generic.

## Record for Each Rehearsal

- Date
- Operator
- Machine / macOS version
- Model configuration
- Workflow
- Result: pass or fail
- Failure reason, if any
- Suitable for recording: yes or no
