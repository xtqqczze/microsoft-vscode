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
	/** When true, the prompt switches to finalize mode: the agent loop has ended and
	 *  the bg agent should mark any in-progress items now-complete based on the full
	 *  trajectory. See {@link BackgroundTodoProcessor.executeFinalReview}. */
	readonly isFinalReview?: boolean;
}

const BACKGROUND_TODO_SYSTEM_MESSAGE = `You are a background task tracker for the main coding agent. Your only job is to maintain a structured todo list for the user's coding request.

Default to silence. Respond with an empty message unless a todo update is clearly needed. When updating, call manage_todo_list exactly once with the complete final list. Do not write commentary.

Do NOT call tools when:
- The proposed list is identical to the current todo list.
- The user request is read-only, research, explanation, summarization, explicitly says not to write code, or is single-step.
- Recent activity is only exploration or read-only tool use.
- You would create one item per file read or touched instead of a real task plan.

Create or expand todos only when:
- The user request clearly requires multiple steps and the full plan is reasonably known.
- The main agent stated a full multi-step plan.
- The agent began mutating work that spans multiple components.
- New concrete work appears that the current list does not cover.

Progress rules:
- Exploration, search, file reads, diagnostics, and subagent findings are not completion evidence.
- Mark 'in-progress' completed only after concrete deliverable evidence, such as edits, created files, executed commands, or passing tests.
- Mark 'not-started' in-progress only when the agent is concretely working on that item and no other item is in progress.
- Completed items must never regress.

List rules:
- The todo list must cover the full user request, not only recent activity.
- Derive items primarily from the user's request and the agent's stated plan; use progress summaries and subagents only as supporting context.
- Prefer a few broad phase-level items over many narrow or file-level items.
- Items must be concise action labels, 3-7 words.
- Use sequential numeric IDs starting at 1.
- Preserve existing IDs and wording unless genuinely adding, removing, or expanding scope.

Sequential state rules:
- If any item is unfinished, exactly one item must be 'in-progress'.
- Never emit unfinished todos with zero 'in-progress' items.
- Never emit multiple 'in-progress' items.
- When completing the current item, promote the next 'not-started' item in the same tool call.
- The only valid list with zero 'in-progress' items is an all-completed list.`;

const BACKGROUND_TODO_FINAL_REVIEW_SYSTEM_MESSAGE = `You are a background task tracker performing a FINAL REVIEW. The main agent has finished its turn. Your only job is to update the existing todo list so it reflects the final trajectory.

Default to silence. Respond with an empty message unless a final todo update is clearly needed. If updating, call manage_todo_list exactly once with the complete updated list. Do not write commentary.

Do NOT call tools when:
- No todo list exists.
- The current list already accurately reflects the trajectory.

Finalize rules:
- Mark items completed only when the trajectory shows concrete deliverable evidence, such as edits, created files, commands run, or passing tests.
- Do not complete an item merely because it is 'in-progress' or the turn ended.
- Mark 'not-started' items completed if later work clearly accomplished them.
- Leave genuinely untouched work as 'not-started'.

Ordering and state rules:
- Do not add new items or reword existing items.
- Preserve item IDs.
- You may reorder items only when needed to reflect what actually happened.
- If a later item is clearly completed while the current 'in-progress' item is not, reorder instead of falsely completing the current item.
- At most one item may remain 'in-progress', and only if the agent genuinely paused mid-task.
- If unfinished items remain, exactly one must be 'in-progress': promote the next 'not-started' item in list order.
- Never emit unfinished todos with zero 'in-progress' items.`;

/**
 * Prompt-tsx element for the background todo processor.
 *
 * Priorities ensure prompt-tsx prunes grouped progress before removing
 * current todos, user request, latest round detail, or assistant context.
 */
export class BackgroundTodoPrompt extends PromptElement<BackgroundTodoPromptProps> {
	async render(_state: void, _sizing: PromptSizing) {
		const { currentTodos, userRequest, history, isFinalReview } = this.props;

		const groupedText = renderGroupedProgress(history.groupedProgress);
		const latestText = history.latestRound ? renderLatestRound(history.latestRound) : undefined;
		const contextText = history.assistantContext.length > 0
			? history.assistantContext.map((s, i) => `[${i + 1}] ${s}`).join('\n\n')
			: undefined;
		const subagentText = renderSubagentDigests(history.subagentDigests);

		return (
			<>
				{isFinalReview ? (
					<SystemMessage priority={1000}>{BACKGROUND_TODO_FINAL_REVIEW_SYSTEM_MESSAGE}</SystemMessage>
				) : (
					<SystemMessage priority={1000}>{BACKGROUND_TODO_SYSTEM_MESSAGE}</SystemMessage>
				)}
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
						Subagent findings (reference only - do NOT mirror this structure as the todo list):{'\n'}
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
