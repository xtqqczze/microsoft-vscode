/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BasePromptElementProps, PromptElement, PromptSizing, SystemMessage, UserMessage } from '@vscode/prompt-tsx';
import { IBackgroundTodoHistory, renderGroupedProgress, renderLatestRound } from './backgroundTodoProcessor';

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

		return (
			<>
				<SystemMessage priority={1000}>
					You are a background task tracker. Your ONLY job is to maintain a structured todo list that tracks the main coding agent's progress on the user's request.{'\n'}
					{'\n'}
					RULES:{'\n'}
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
					PROGRESS SIGNALS:{'\n'}
					- Read-only tools (read_file, list_dir, grep_search, semantic_search, etc.) are exploration — they do NOT mean a task is completed. Keep the associated task 'in-progress' until you see mutating actions (file edits, terminal commands, test runs) that finish the work.{'\n'}
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
