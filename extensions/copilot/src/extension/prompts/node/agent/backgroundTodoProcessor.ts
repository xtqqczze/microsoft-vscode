/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, CancellationTokenSource } from '../../../../util/vs/base/common/cancellation';
import { ChatFetchResponseType, ChatLocation, ChatResponse } from '../../../../platform/chat/common/commonTypes';
import { IEndpointProvider } from '../../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../../platform/log/common/logService';
import { IChatEndpoint } from '../../../../platform/networking/common/networking';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ToolCallingLoop } from '../../../intents/node/toolCallingLoop';
import { IBuildPromptContext } from '../../../prompt/common/intents';
import { ITodoListContextProvider } from '../../../prompt/node/todoListContextProvider';
import { normalizeToolSchema } from '../../../tools/common/toolSchemaNormalizer';
import { ToolName } from '../../../tools/common/toolNames';
import { IToolsService } from '../../../tools/common/toolsService';
import { renderPromptElement } from '../base/promptRenderer';
import { BackgroundTodoDeltaTracker, IBackgroundTodoDelta } from './backgroundTodoDelta';
import { BackgroundTodoPrompt } from './backgroundTodoPrompt';

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

// ── Invocation policy ───────────────────────────────────────────

/** Typed outcome of the invocation policy decision. */
export const enum BackgroundTodoDecision {
	/** A background pass should start now. */
	Run = 'run',
	/** There is activity but the processor should wait for more. */
	Wait = 'wait',
	/** The background todo agent should not run at all. */
	Skip = 'skip',
}

/** Detailed reason behind a policy decision, useful for logging/telemetry. */
export type BackgroundTodoDecisionReason =
	| 'experimentDisabled'
	| 'todoToolExplicitlyEnabled'
	| 'nonAgentPrompt'
	| 'noProcessor'
	| 'noDelta'
	| 'processorInProgress'
	| 'ready';

export interface IBackgroundTodoDecisionResult {
	readonly decision: BackgroundTodoDecision;
	readonly reason: BackgroundTodoDecisionReason;
	/** The delta snapshot when decision is `Run`; `undefined` otherwise. */
	readonly delta?: IBackgroundTodoDelta;
}

/**
 * External state the policy needs but does not own.
 * Callers construct this once and pass it in.
 */
export interface IBackgroundTodoPolicyInput {
	/** Whether the experiment gate is enabled. */
	readonly experimentEnabled: boolean;
	/** Whether the user explicitly referenced the todo tool (e.g. `#todo`). */
	readonly todoToolExplicitlyEnabled: boolean;
	/** Whether the current prompt is the main agent prompt. */
	readonly isAgentPrompt: boolean;
	/** The current prompt context for delta computation. */
	readonly promptContext: IBuildPromptContext;
}

/**
 * Bundles the services the processor needs for execution but does not own.
 * Passed by the caller so the processor stays testable without full DI.
 */
export interface IBackgroundTodoExecutionContext {
	readonly instantiationService: IInstantiationService;
	readonly logService: ILogService;
	readonly toolsService: IToolsService;
	readonly telemetryService: ITelemetryService;
	readonly promptContext: IBuildPromptContext;
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

	// ── Invocation policy ───────────────────────────────────────

	/**
	 * Evaluate the invocation policy and return a typed decision.
	 *
	 * The processor owns this method so that all decision logic lives
	 * next to the state it depends on (processor state, delta tracker).
	 * Callers supply only the external context they already have.
	 */
	shouldRun(input: IBackgroundTodoPolicyInput): IBackgroundTodoDecisionResult {
		if (!input.experimentEnabled) {
			return { decision: BackgroundTodoDecision.Skip, reason: 'experimentDisabled' };
		}
		if (input.todoToolExplicitlyEnabled) {
			return { decision: BackgroundTodoDecision.Skip, reason: 'todoToolExplicitlyEnabled' };
		}
		if (!input.isAgentPrompt) {
			return { decision: BackgroundTodoDecision.Skip, reason: 'nonAgentPrompt' };
		}

		const delta = this.deltaTracker.peekDelta(input.promptContext);
		if (!delta) {
			return { decision: BackgroundTodoDecision.Skip, reason: 'noDelta' };
		}

		if (this._state === BackgroundTodoProcessorState.InProgress) {
			// There is new activity but a pass is already running.
			// The delta will be coalesced via `start()` when the caller
			// proceeds — return Wait so logging distinguishes this from Skip.
			return { decision: BackgroundTodoDecision.Wait, reason: 'processorInProgress', delta };
		}

		return { decision: BackgroundTodoDecision.Run, reason: 'ready', delta };
	}

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

	// ── Execution ──────────────────────────────────────────────

	/**
	 * Convenience method: starts a background pass using the built-in
	 * execution logic (acquire copilot-fast endpoint → render prompt →
	 * call model → invoke todo tool).
	 */
	executePass(
		delta: IBackgroundTodoDelta,
		context: IBackgroundTodoExecutionContext,
		parentToken?: CancellationToken,
	): void {
		this.start(
			delta,
			(d, token) => BackgroundTodoProcessor._doExecute(d, context, token),
			parentToken,
		);
	}

	/**
	 * The actual background work: render the todo prompt against copilot-fast,
	 * parse tool calls, and invoke the todo tool.
	 */
	private static async _doExecute(
		delta: IBackgroundTodoDelta,
		context: IBackgroundTodoExecutionContext,
		token: CancellationToken,
	): Promise<IBackgroundTodoResult> {
		const startTime = Date.now();
		const conversationId = context.promptContext.conversation?.sessionId;
		const associatedRequestId = context.promptContext.conversation?.getLatestTurn()?.id;

		let fastEndpoint: IChatEndpoint;
		try {
			fastEndpoint = await context.instantiationService.invokeFunction(async (accessor) => {
				const ep = accessor.get(IEndpointProvider);
				return ep.getChatEndpoint('copilot-fast');
			});
		} catch (err) {
			context.logService.warn(`[BackgroundTodo] copilot-fast endpoint unavailable, skipping pass: ${err}`);
			BackgroundTodoProcessor._sendTelemetry(context.telemetryService, 'skipped', conversationId, associatedRequestId, Date.now() - startTime);
			return { outcome: 'noop' };
		}

		// Read current todo state
		const todoContext = delta.sessionResource
			? await context.instantiationService.invokeFunction(async (accessor) => {
				const todoProvider = accessor.get<ITodoListContextProvider>(ITodoListContextProvider);
				return todoProvider.getCurrentTodoContext(delta.sessionResource!);
			})
			: undefined;

		// Render the prompt
		const { messages } = await renderPromptElement(
			context.instantiationService,
			fastEndpoint,
			BackgroundTodoPrompt,
			{ currentTodos: todoContext, delta },
			undefined,
			token,
		);

		// Build the single-tool schema for manage_todo_list
		const todoToolSchema = [{
			function: {
				name: ToolName.CoreManageTodoList,
				description: 'Update the todo list with current progress.',
				parameters: {
					type: 'object',
					properties: {
						todoList: {
							type: 'array',
							items: {
								type: 'object',
								properties: {
									id: { type: 'number' },
									title: { type: 'string' },
									status: { type: 'string', enum: ['not-started', 'in-progress', 'completed'] },
								},
								required: ['id', 'title', 'status'],
							},
						},
					},
					required: ['todoList'],
				},
			},
			type: 'function' as const,
		}];

		const normalizedTools = normalizeToolSchema(
			fastEndpoint.family,
			todoToolSchema,
			(tool, rule) => {
				context.logService.warn(`[BackgroundTodo] Tool ${tool} failed validation: ${rule}`);
			},
		);

		// Make the request
		const toolCalls: { name: string; arguments: string; id: string }[] = [];
		const response: ChatResponse = await fastEndpoint.makeChatRequest2({
			debugName: 'backgroundTodoAgent',
			messages: ToolCallingLoop.stripInternalToolCallIds(messages),
			finishedCb: async (_text, _index, fetchDelta) => {
				if (fetchDelta.copilotToolCalls) {
					toolCalls.push(...fetchDelta.copilotToolCalls);
				}
				return undefined;
			},
			location: ChatLocation.Other,
			requestOptions: {
				temperature: 0,
				stream: false,
				tools: normalizedTools,
			},
			userInitiatedRequest: false,
			requestKindOptions: { kind: 'background' },
			telemetryProperties: associatedRequestId ? { associatedRequestId } : undefined,
		}, token);

		const durationMs = Date.now() - startTime;
		const usage = response.type === ChatFetchResponseType.Success ? response.usage : undefined;

		// Process tool calls — only accept manage_todo_list
		const todoCall = toolCalls.find(tc => tc.name === ToolName.CoreManageTodoList);
		if (!todoCall) {
			context.logService.debug('[BackgroundTodo] model returned no todo tool call (no-op)');
			BackgroundTodoProcessor._sendTelemetry(context.telemetryService, 'noop', conversationId, associatedRequestId, durationMs, usage?.prompt_tokens, usage?.completion_tokens, fastEndpoint.model);
			return { outcome: 'noop', promptTokens: usage?.prompt_tokens, completionTokens: usage?.completion_tokens, durationMs, model: fastEndpoint.model };
		}

		// Validate and invoke the tool
		let parsedInput: unknown;
		try {
			parsedInput = JSON.parse(todoCall.arguments);
		} catch {
			context.logService.warn('[BackgroundTodo] failed to parse tool call arguments');
			BackgroundTodoProcessor._sendTelemetry(context.telemetryService, 'toolInvokeError', conversationId, associatedRequestId, durationMs, usage?.prompt_tokens, usage?.completion_tokens, fastEndpoint.model);
			return { outcome: 'noop', durationMs, model: fastEndpoint.model };
		}

		try {
			const toolInvocationToken = (context.promptContext.tools?.toolInvocationToken) ?? undefined;
			await context.toolsService.invokeTool(ToolName.CoreManageTodoList, {
				input: parsedInput,
				toolInvocationToken: toolInvocationToken!,
			}, token);
		} catch (err) {
			context.logService.warn(`[BackgroundTodo] tool invocation failed: ${err}`);
			BackgroundTodoProcessor._sendTelemetry(context.telemetryService, 'toolInvokeError', conversationId, associatedRequestId, durationMs, usage?.prompt_tokens, usage?.completion_tokens, fastEndpoint.model);
			return { outcome: 'noop', durationMs, model: fastEndpoint.model };
		}

		context.logService.debug(`[BackgroundTodo] todo list updated successfully (${durationMs}ms)`);
		BackgroundTodoProcessor._sendTelemetry(context.telemetryService, 'success', conversationId, associatedRequestId, durationMs, usage?.prompt_tokens, usage?.completion_tokens, fastEndpoint.model);
		return { outcome: 'success', promptTokens: usage?.prompt_tokens, completionTokens: usage?.completion_tokens, durationMs, model: fastEndpoint.model };
	}

	private static _sendTelemetry(
		telemetryService: ITelemetryService,
		outcome: string,
		conversationId: string | undefined,
		chatRequestId: string | undefined,
		durationMs: number,
		promptTokens?: number,
		completionTokens?: number,
		model?: string,
	): void {
		/* __GDPR__
			"backgroundTodoAgent" : {
				"owner": "vritant24",
				"comment": "Tracks background todo agent pass outcomes.",
				"outcome": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The outcome of the background todo pass." },
				"conversationId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Id for the current chat conversation." },
				"chatRequestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The chat request ID." },
				"model": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The model ID used." },
				"duration": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true, "comment": "Duration in ms." },
				"promptTokenCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true, "comment": "Prompt token count." },
				"completionTokenCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true, "comment": "Completion token count." }
			}
		*/
		telemetryService.sendMSFTTelemetryEvent('backgroundTodoAgent', {
			outcome,
			conversationId,
			chatRequestId,
			model,
		}, {
			duration: durationMs,
			promptTokenCount: promptTokens,
			completionTokenCount: completionTokens,
		});
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
