/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, CancellationTokenSource } from '../../../../util/vs/base/common/cancellation';
import { BackgroundTodoDeltaTracker, IBackgroundTodoDelta } from './backgroundTodoDelta';

/**
 * State machine for a background todo processor.
 *
 * Lifecycle:
 *   Idle → InProgress → Idle (success / no-op)
 *                     → Failed → InProgress (retry on next delta)
 *
 * Cancellation cascades from the parent token or an explicit cancel() call.
 */

export const enum BackgroundTodoProcessorState {
	Idle = 'Idle',
	InProgress = 'InProgress',
	Failed = 'Failed',
}

export interface IBackgroundTodoResult {
	/** 'success' when a todo tool call was made, 'noop' when the model decided no update was needed. */
	readonly outcome: 'success' | 'noop';
	readonly promptTokens?: number;
	readonly completionTokens?: number;
	readonly durationMs?: number;
	readonly model?: string;
}

/**
 * Manages a single background todo processor per chat session.
 *
 * Owns a {@link BackgroundTodoDeltaTracker} for high-watermark tracking
 * and coalesces concurrent updates so at most one background pass runs
 * at a time.
 */
export class BackgroundTodoProcessor {

	private _state: BackgroundTodoProcessorState = BackgroundTodoProcessorState.Idle;
	private _promise: Promise<void> | undefined;
	private _cts: CancellationTokenSource | undefined;
	private _lastError: unknown;
	private _pendingDelta: IBackgroundTodoDelta | undefined;

	readonly deltaTracker = new BackgroundTodoDeltaTracker();

	get state(): BackgroundTodoProcessorState { return this._state; }
	get lastError(): unknown { return this._lastError; }

	/**
	 * Start a background pass if one is not already running.
	 *
	 * If a pass is in progress, the delta is stashed and will be processed
	 * automatically when the current pass completes.
	 *
	 * @param delta The new activity to process.
	 * @param work  An async function that performs the actual model call and
	 *              tool invocation. It receives a cancellation token.
	 * @param parentToken Optional parent cancellation token.
	 */
	start(
		delta: IBackgroundTodoDelta,
		work: (delta: IBackgroundTodoDelta, token: CancellationToken) => Promise<IBackgroundTodoResult>,
		parentToken?: CancellationToken,
	): void {
		if (this._state === BackgroundTodoProcessorState.InProgress) {
			// Coalesce: stash the latest delta for when the current pass finishes.
			this._pendingDelta = delta;
			return;
		}

		this._runPass(delta, work, parentToken);
	}

	private _runPass(
		delta: IBackgroundTodoDelta,
		work: (delta: IBackgroundTodoDelta, token: CancellationToken) => Promise<IBackgroundTodoResult>,
		parentToken?: CancellationToken,
	): void {
		this._state = BackgroundTodoProcessorState.InProgress;
		this._lastError = undefined;
		this._cts = new CancellationTokenSource(parentToken);
		const token = this._cts.token;

		this._promise = work(delta, token).then(
			() => {
				if (this._state !== BackgroundTodoProcessorState.InProgress) {
					return; // cancelled while in flight
				}
				this.deltaTracker.markProcessed(delta);
				this._state = BackgroundTodoProcessorState.Idle;
				this._checkPending(work, parentToken);
			},
			(err) => {
				if (this._state !== BackgroundTodoProcessorState.InProgress) {
					return; // cancelled while in flight
				}
				this._lastError = err;
				this._state = BackgroundTodoProcessorState.Failed;
				// Still advance the cursor so we don't retry the exact same delta.
				this.deltaTracker.markProcessed(delta);
				this._checkPending(work, parentToken);
			},
		);
	}

	/**
	 * If a delta was stashed while a pass was running, start a new pass now.
	 */
	private _checkPending(
		work: (delta: IBackgroundTodoDelta, token: CancellationToken) => Promise<IBackgroundTodoResult>,
		parentToken?: CancellationToken,
	): void {
		const pending = this._pendingDelta;
		if (pending) {
			this._pendingDelta = undefined;
			this._runPass(pending, work, parentToken);
		}
	}

	/**
	 * Wait for any in-flight pass to settle (success or failure).
	 * Returns immediately if idle.
	 */
	async waitForCompletion(): Promise<void> {
		if (this._promise) {
			await this._promise;
		}
	}

	/**
	 * Cancel any in-flight pass and reset to Idle.
	 */
	cancel(): void {
		this._cts?.cancel();
		this._cts?.dispose();
		this._cts = undefined;
		this._state = BackgroundTodoProcessorState.Idle;
		this._lastError = undefined;
		this._promise = undefined;
		this._pendingDelta = undefined;
	}
}
