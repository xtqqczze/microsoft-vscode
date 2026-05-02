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
					- If the todo list needs updating based on the agent's recent activity, call the manage_todo_list tool with the complete updated list.{'\n'}
					- If no update is needed, respond with an empty message — do NOT call any tools.{'\n'}
					- Do NOT produce explanatory text or commentary. Only call the tool or stay silent.{'\n'}
					- Todo items should be concise action-oriented labels (3-7 words).{'\n'}
					- Mark items as 'completed' when the agent's tool calls show the work is done.{'\n'}
					- Mark items as 'in-progress' when the agent is actively working on them.{'\n'}
					- Keep items as 'not-started' when they haven't been addressed yet.{'\n'}
					- At most one item should be 'in-progress' at a time.{'\n'}
					- Use sequential numeric IDs starting from 1.{'\n'}
					- Preserve existing item IDs when updating status; only change IDs when adding/removing items.{'\n'}
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
