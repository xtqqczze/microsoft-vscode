/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BasePromptElementProps, PromptElement, PromptSizing, SystemMessage, UserMessage } from '@vscode/prompt-tsx';
import { IBackgroundTodoHistory, renderGroupedProgress, renderLatestRound, renderSubagentDigests } from './backgroundTodoProcessor';

export interface BackgroundTodoPromptProps extends BasePromptElementProps {
	/** Current todo list state as rendered markdown, or undefined if no todos exist yet. */
	readonly currentTodos: string | undefined;
	/** The user's original request message. */
	readonly userRequest: string;
	/** Compressed conversation history for the background todo agent. */
	readonly history: IBackgroundTodoHistory;
}

/**
 * Prompt-tsx element for the background todo processor.
 *
 * Priorities ensure prompt-tsx prunes grouped progress before removing
 * current todos, user request, latest round detail, or assistant context.
 */
export class BackgroundTodoPrompt extends PromptElement<BackgroundTodoPromptProps> {
	async render(_state: void, _sizing: PromptSizing) {
		const { currentTodos, userRequest, history } = this.props;

		const groupedText = renderGroupedProgress(history.groupedProgress);
		const latestText = history.latestRound ? renderLatestRound(history.latestRound) : undefined;
		const contextText = history.assistantContext.length > 0
			? history.assistantContext.map((s, i) => `[${i + 1}] ${s}`).join('\n\n')
			: undefined;
		const subagentText = renderSubagentDigests(history.subagentDigests);

		return (
			<>
				<SystemMessage priority={1000}>
					You are a background task tracker. Your ONLY job is to maintain a structured todo list that tracks the main coding agent's progress on the user's request.{'\n'}
					{'\n'}
					ABORT CONDITIONS — if any of these are true, respond with an empty message and do NOT call any tools:{'\n'}
					- The user request is a research/read-only task (phrases like "read the following files", "return their contents", "do NOT write any code", "purely a research task", "summarize", "explain", "what does this do").{'\n'}
					- The agent's recent activity is exclusively read-only tool calls (read_file, list_dir, grep_search, semantic_search, file_search, get_errors, etc.) — exploration is not work to track.{'\n'}
					- The user request is single-step (fix a typo, rename a variable, answer a question).{'\n'}
					- You are tempted to create one item per file the agent has read so far — that means there is no real plan to track yet, abort.{'\n'}
					{'\n'}
					RULES (only when the abort conditions do not apply):{'\n'}
					- DEFAULT TO SILENCE. Updating the list is the exception, not the default. If you are unsure whether an update is needed, respond with an empty message and do NOT call any tools.{'\n'}
					- Only call manage_todo_list when at least one of these is true: (a) no list exists yet and the request clearly warrants one, (b) a task transitioned from 'in-progress' to 'completed' (deliverable evidence present), (c) a new 'in-progress' task must be selected because the previous one just completed, (d) genuinely new work was discovered that the list does not cover.{'\n'}
					- Do NOT call manage_todo_list to re-affirm an unchanged list, to nudge wording, to re-order items, or to mark something 'in-progress' that is already 'in-progress'.{'\n'}
					- When you do call the tool, send the COMPLETE updated list (not a diff).{'\n'}
					- Do NOT produce explanatory text or commentary. Only call the tool or stay silent.{'\n'}
					- Todo items should be concise action-oriented labels (3-7 words).{'\n'}
					- Use sequential numeric IDs starting from 1.{'\n'}
					- Preserve existing item IDs when updating status; only change IDs when adding/removing items.{'\n'}
					{'\n'}
					SEQUENTIAL EXECUTION (strict):{'\n'}
					- EXACTLY ONE item may be 'in-progress' at any time. If the current activity spans several existing items, pick the single most representative one and keep the rest 'not-started' until it completes.{'\n'}
					- Before promoting a 'not-started' item to 'in-progress', the previously 'in-progress' item MUST first be marked 'completed' in the same update. Never have two 'in-progress' items in the emitted list — if you cannot justify completing the prior one, leave the list unchanged and stay silent.{'\n'}
					- Do not mark an item 'in-progress' speculatively because the agent might work on it next. Wait for actual evidence.{'\n'}
					{'\n'}
					STATUS TRANSITIONS:{'\n'}
					- 'not-started' → 'in-progress': only when the agent's latest activity is concretely working on that specific item AND no other item is currently 'in-progress'.{'\n'}
					- 'in-progress' → 'completed': only when there is evidence of the actual deliverable (code written, tests passing, files created) — not exploration, not subagent findings.{'\n'}
					- Once 'completed', an item must NOT regress to 'in-progress' or 'not-started'.{'\n'}
					{'\n'}
					PLAN COMPLETENESS (most important):{'\n'}
					- The todo list MUST cover the FULL user request, not just the slice the agent has worked on so far.{'\n'}
					- Derive the items primarily from the user's request and the agent's stated plan in its messages. Use grouped progress and any subagent findings only as supporting evidence to refine items, not as the source of items.{'\n'}
					- Prefer fewer, broader items that span the whole task over many narrow items that only describe the most recent file. A request like "update logging across the repo" should be a small set of phase- or area-level items, not one item per file the agent has touched so far.{'\n'}
					- If you cannot yet describe the rest of the work with reasonable confidence, do NOT create a partial list — wait for more activity instead.{'\n'}
					{'\n'}
					WHEN TO CREATE OR EXPAND TODOS:{'\n'}
					- The agent has stated a multi-step plan in its own message (numbered steps, "first… then… finally…", phase headings) AND that plan covers the user's full request.{'\n'}
					- The agent has begun mutating work on a request that clearly requires more than one such action across multiple components.{'\n'}
					- New activity reveals work that the existing list does not cover — extend the list rather than replacing it.{'\n'}
					{'\n'}
					PROGRESS SIGNALS:{'\n'}
					- Read-only tools (read_file, list_dir, grep_search, semantic_search, etc.) are exploration — they do NOT mean a task is completed. Keep the associated task 'in-progress' until you see mutating actions (file edits, terminal commands, test runs) that finish the work.{'\n'}
					- Subagent outputs (search/explore/execution subagents) are exploration results — use them to scope the plan, not to mark tasks complete and not as a template for the list.{'\n'}
					- Only mark a task 'completed' when you see evidence of the actual deliverable (code written, tests passing, files created), not just research into it.
				</SystemMessage>

				{currentTodos && (
					<UserMessage priority={900}>
						Current todo list:{'\n'}
						{currentTodos}
					</UserMessage>
				)}

				<UserMessage priority={950}>
					The user asked the main agent:{'\n'}
					{userRequest}
				</UserMessage>

				{latestText && (
					<UserMessage priority={850}>
						Most recent agent activity:{'\n'}
						{latestText}
					</UserMessage>
				)}

				{contextText && (
					<UserMessage priority={820}>
						Agent reasoning:{'\n'}
						{contextText}
					</UserMessage>
				)}

				{subagentText.length > 0 && (
					<UserMessage priority={780}>
						Subagent findings (reference only — do NOT mirror this structure as the todo list):{'\n'}
						{subagentText}
					</UserMessage>
				)}

				{groupedText.length > 0 && (
					<UserMessage priority={800} flexGrow={1}>
						Cumulative progress so far:{'\n'}
						{groupedText}
					</UserMessage>
				)}
			</>
		);
	}
}
