/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BasePromptElementProps, PromptElement, PromptSizing, SystemMessage, UserMessage } from '@vscode/prompt-tsx';
import { IBackgroundTodoDelta } from './backgroundTodoDelta';

export interface BackgroundTodoPromptProps extends BasePromptElementProps {
	/** Current todo list state as rendered markdown, or undefined if no todos exist yet. */
	readonly currentTodos: string | undefined;
	/** The delta of new conversation activity to evaluate. */
	readonly delta: IBackgroundTodoDelta;
}

/**
 * Prompt-tsx element for the background todo processor.
 *
 * Priorities ensure prompt-tsx prunes older history before removing
 * current todos, user request, or latest tool-call deltas.
 */
export class BackgroundTodoPrompt extends PromptElement<BackgroundTodoPromptProps> {
	async render(_state: void, _sizing: PromptSizing) {
		const { currentTodos, delta } = this.props;

		// Build a compact summary of new tool-call rounds
		const roundSummaries = delta.newRounds.map(round => {
			const toolNames = round.toolCalls.map(tc => tc.name).join(', ');
			const responseSnippet = typeof round.response === 'string'
				? round.response.slice(0, 500)
				: '';
			return `[Round ${round.id}] Tools: ${toolNames}\nResponse: ${responseSnippet}`;
		}).join('\n\n');

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
					- Preserve existing item IDs when updating status; only change IDs when adding/removing items.
				</SystemMessage>

				{currentTodos && (
					<UserMessage priority={900}>
						Current todo list:{'\n'}
						{currentTodos}
					</UserMessage>
				)}

				<UserMessage priority={950}>
					The user asked the main agent:{'\n'}
					{delta.userRequest}
				</UserMessage>

				{roundSummaries.length > 0 && (
					<UserMessage priority={800} flexGrow={1}>
						Recent agent activity (new tool call rounds):{'\n'}
						{roundSummaries}
					</UserMessage>
				)}
			</>
		);
	}
}
