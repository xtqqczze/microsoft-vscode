# Background Todo Agent

## Overview

The background todo agent offloads todo-list maintenance from the main (expensive) model to a cheap `copilot-fast` model. When enabled, the main agent no longer receives the `manage_todo_list` tool; instead, a background processor monitors the agent's conversation and calls the todo tool itself.

The feature is gated behind the experiment setting `github.copilot.chat.agent.backgroundTodoAgent.enabled` (default `false`).

## Architecture

```text
┌──────────────────────────────────────────────────────────┐
│                    AgentIntent                           │
│  ┌────────────────────┐  ┌─────────────────────────────┐ │
│  │ _backgroundSumma-  │  │ _backgroundTodoProcessors   │ │
│  │ rizers (per session)│  │ (per session)               │ │
│  └────────────────────┘  └─────────────────────────────┘ │
│         Session lifecycle: cancel + delete on dispose     │
└──────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────┐
│              AgentIntentInvocation.buildPrompt            │
│                                                          │
│  1. Set hideTodoPromptInstructions on AgentPromptProps    │
│  2. After main render, call _maybeStartBackgroundTodoPass │
└──────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────┐
│             BackgroundTodoProcessor                       │
│                                                          │
│  State machine: Idle → InProgress → Idle / Failed        │
│  - Owns a BackgroundTodoDeltaTracker                     │
│  - Coalesces concurrent updates (stashes pending delta)  │
│  - Advances cursor on both success and failure           │
└──────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────┐
│           _executeBackgroundTodoPass                      │
│                                                          │
│  1. Resolve copilot-fast endpoint (skip if unavailable)  │
│  2. Read current todos via ITodoListContextProvider       │
│  3. Render BackgroundTodoPrompt (prompt-tsx)              │
│  4. Send request with manage_todo_list as only tool       │
│  5. Parse tool call response, invoke manage_todo_list     │
│  6. Send telemetry                                        │
└──────────────────────────────────────────────────────────┘
```

## Key Files

| File | Purpose |
| ---- | ------- |
| `configurationService.ts` | `BackgroundTodoAgentEnabled` experiment config key |
| `agentIntent.ts` | Gate logic, processor lifecycle, background work orchestration |
| `backgroundTodoProcessor.ts` | State machine (Idle/InProgress/Failed), coalescing, cancellation |
| `backgroundTodoDelta.ts` | High-watermark cursor tracking which rounds have been processed |
| `backgroundTodoPrompt.tsx` | Prompt-tsx element rendered against copilot-fast |
| `defaultAgentInstructions.tsx` | `hideTodoPromptInstructions` prop on `DefaultAgentPromptProps` |
| Model prompt files (gpt5*.tsx, etc.) | Suppressed markdown-fallback guidance when gate is on |

## Enablement Logic

The feature has three layers of control:

### 1. Tool Availability (`getAgentTools`)

When the experiment is enabled, `allowTools[ToolName.CoreManageTodoList]` is set to `false` unconditionally. The main model never sees the tool.

### 2. Prompt Instructions (`hideTodoPromptInstructions`)

When the experiment is enabled **and** the user hasn't explicitly referenced `#todo`, the `hideTodoPromptInstructions` prop is set to `true` on `AgentPromptProps`. This silently suppresses:

- Todo-tool-specific guidance (`tools[ToolName.CoreManageTodoList] && ...` blocks)
- Markdown-checkbox fallback guidance (`!tools[ToolName.CoreManageTodoList] && ...` blocks)

No replacement text is injected — the main agent simply has no todo-related instructions.

### 3. Background Watcher (`_maybeStartBackgroundTodoPass`)

The background processor is started when all of these are true:

- Experiment is enabled
- User hasn't explicitly referenced `#todo` (via `isTodoToolExplicitlyEnabled`)
- Prompt is the main `AgentPrompt` (not inline/notebook prompts)
- There's a valid session ID
- The delta tracker has new activity since the last pass

### Explicit Override (`isTodoToolExplicitlyEnabled`)

If the user types `#todo` in their message (detected via `request.toolReferences`), the background watcher stands down and prompt instructions are restored. The main model's todo tool remains disabled (the experiment gate in `getAgentTools` is unconditional) but the prompt guidance returns.

This uses `request.toolReferences` rather than `request.tools` because core tools always appear as `enabled=true` in the default tool picker state, which would prevent the experiment from ever taking effect.

## Delta Tracking

`BackgroundTodoDeltaTracker` maintains a set of processed round IDs. On each `buildPrompt` call:

1. It scans `promptContext.toolCallRounds` and `promptContext.history` for rounds not yet in the processed set
2. On the first invocation (empty processed set + no new rounds), it produces a delta with just the user request so the background agent can create an initial plan
3. After a pass completes (success or failure), the delta's round IDs are added to the processed set
4. Subsequent calls with no new rounds return `undefined` (no-op)

## Concurrency Model

At most one background pass runs per session. If `start()` is called while a pass is in-flight:

- The new delta is stashed as `_pendingDelta`
- When the current pass completes, the stashed delta is automatically processed
- Only the latest stashed delta survives (earlier ones are replaced)

## Request Configuration

Background requests use:

- `userInitiatedRequest: false`
- `requestKindOptions: { kind: 'background' }` → sets `X-Interaction-Type: conversation-background`
- `ChatLocation.Other`
- `temperature: 0`
- Only `manage_todo_list` in the tool schema
- No fallback to expensive models if `copilot-fast` is unavailable

## Telemetry

The `backgroundTodoAgent` telemetry event tracks:

- `outcome`: `success`, `noop`, `skipped`, `toolInvokeError`
- `conversationId`, `chatRequestId`, `model`
- `duration`, `promptTokenCount`, `completionTokenCount`

## Test Coverage

| Test File | What It Tests |
| --------- | ------------- |
| `backgroundTodoDelta.spec.ts` | Delta tracker: first invocation, round tracking, cursor advancement, history turns, reset |
| `backgroundTodoProcessor.spec.ts` | State machine: transitions, cursor advancement, coalescing, cancellation, parent token |
| `backgroundTodoEnablement.spec.ts` | `isTodoToolExplicitlyEnabled` (6 cases) + `getAgentTools` integration (3 cases) |
