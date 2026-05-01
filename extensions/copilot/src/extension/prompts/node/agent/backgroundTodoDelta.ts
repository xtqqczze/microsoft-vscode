/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Turn } from '../../../prompt/common/conversation';
import { IBuildPromptContext, IToolCallRound } from '../../../prompt/common/intents';

/**
 * Snapshot of new activity since the last background todo pass.
 */
export interface IBackgroundTodoDelta {
	/** The user's original request message (from the current or most recent turn). */
	readonly userRequest: string;
	/** New tool call rounds not yet seen by the background todo processor. */
	readonly newRounds: readonly IToolCallRound[];
	/** Full conversation history (read-only reference, stable within a turn). */
	readonly history: readonly Turn[];
	/** Session resource URI string, needed for todo tool invocation. */
	readonly sessionResource: string | undefined;
}

/**
 * Tracks which tool-call rounds the background todo processor has already
 * considered and produces deltas containing only new activity.
 *
 * This utility is independent of invocation policy — callers decide *when*
 * to request a delta and what to do with it.
 */
export class BackgroundTodoDeltaTracker {

	/** Set of round IDs already processed by the background todo agent. */
	private readonly _processedRoundIds = new Set<string>();

	/**
	 * Compute a delta from the current prompt context.
	 *
	 * Returns `undefined` when there is no new activity since the last call.
	 */
	getDelta(promptContext: IBuildPromptContext): IBackgroundTodoDelta | undefined {
		const currentRounds = promptContext.toolCallRounds ?? [];
		const newRounds: IToolCallRound[] = [];

		for (const round of currentRounds) {
			if (!this._processedRoundIds.has(round.id)) {
				newRounds.push(round);
			}
		}

		// Also check history turns for rounds not yet seen (follow-up turns).
		for (const turn of promptContext.history) {
			for (const round of turn.rounds) {
				if (!this._processedRoundIds.has(round.id)) {
					newRounds.push(round);
				}
			}
		}

		// First invocation (nothing processed yet) with no tool call rounds:
		// produce a delta with just the user request so the background agent
		// can set up an initial plan.
		const isFirstInvocation = this._processedRoundIds.size === 0;
		if (newRounds.length === 0 && !isFirstInvocation) {
			return undefined;
		}

		const userRequest = promptContext.query;

		return {
			userRequest,
			newRounds,
			history: promptContext.history,
			sessionResource: (promptContext.request as { sessionResource?: string } | undefined)?.sessionResource
				?? (promptContext.tools?.toolInvocationToken as { sessionResource?: string } | undefined)?.sessionResource,
		};
	}

	/**
	 * Mark all rounds in the given delta as processed so they won't appear
	 * in subsequent deltas.
	 */
	markProcessed(delta: IBackgroundTodoDelta): void {
		for (const round of delta.newRounds) {
			this._processedRoundIds.add(round.id);
		}
	}

	/**
	 * Mark a set of round IDs as processed without requiring a full delta.
	 * Useful when advancing the cursor after a no-op pass.
	 */
	markRoundsProcessed(roundIds: Iterable<string>): void {
		for (const id of roundIds) {
			this._processedRoundIds.add(id);
		}
	}

	/**
	 * Reset the tracker to its initial state.
	 */
	reset(): void {
		this._processedRoundIds.clear();
	}
}
