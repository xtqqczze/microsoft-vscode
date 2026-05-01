/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, test } from 'vitest';
import { BackgroundTodoDecision, BackgroundTodoProcessor, BackgroundTodoProcessorState, IBackgroundTodoPolicyInput } from '../backgroundTodoProcessor';
import { IBuildPromptContext, IToolCallRound } from '../../../../prompt/common/intents';

function makeRound(id: string): IToolCallRound {
	return {
		id,
		response: `response for ${id}`,
		toolInputRetry: 0,
		toolCalls: [{ name: 'read_file', arguments: '{}', id: `tc-${id}` }],
	};
}

function makePromptContext(opts?: {
	query?: string;
	toolCallRounds?: IToolCallRound[];
}): IBuildPromptContext {
	return {
		query: opts?.query ?? 'fix the bug',
		history: [],
		chatVariables: { hasVariables: () => false } as any,
		toolCallRounds: opts?.toolCallRounds,
	};
}

function makeInput(overrides?: Partial<IBackgroundTodoPolicyInput>): IBackgroundTodoPolicyInput {
	return {
		experimentEnabled: true,
		todoToolExplicitlyEnabled: false,
		isAgentPrompt: true,
		promptContext: makePromptContext({ toolCallRounds: [makeRound('r1')] }),
		...overrides,
	};
}

describe('BackgroundTodoProcessor.shouldRun (policy)', () => {

	test('returns Skip when experiment is disabled', () => {
		const processor = new BackgroundTodoProcessor();
		const result = processor.shouldRun(makeInput({ experimentEnabled: false }));
		expect(result.decision).toBe(BackgroundTodoDecision.Skip);
		expect(result.reason).toBe('experimentDisabled');
		expect(result.delta).toBeUndefined();
	});

	test('returns Skip when todo tool is explicitly enabled', () => {
		const processor = new BackgroundTodoProcessor();
		const result = processor.shouldRun(makeInput({ todoToolExplicitlyEnabled: true }));
		expect(result.decision).toBe(BackgroundTodoDecision.Skip);
		expect(result.reason).toBe('todoToolExplicitlyEnabled');
	});

	test('returns Skip for non-agent prompt', () => {
		const processor = new BackgroundTodoProcessor();
		const result = processor.shouldRun(makeInput({ isAgentPrompt: false }));
		expect(result.decision).toBe(BackgroundTodoDecision.Skip);
		expect(result.reason).toBe('nonAgentPrompt');
	});

	test('returns Skip when there is no delta', () => {
		const processor = new BackgroundTodoProcessor();
		// First, mark some rounds as processed so peekDelta returns undefined
		processor.deltaTracker.markRoundsProcessed(['r1']);
		const result = processor.shouldRun(makeInput());
		expect(result.decision).toBe(BackgroundTodoDecision.Skip);
		expect(result.reason).toBe('noDelta');
	});

	test('returns Run when all gates pass and delta exists', () => {
		const processor = new BackgroundTodoProcessor();
		const result = processor.shouldRun(makeInput());
		expect(result.decision).toBe(BackgroundTodoDecision.Run);
		expect(result.reason).toBe('ready');
		expect(result.delta).toBeDefined();
		expect(result.delta!.newRounds).toHaveLength(1);
	});

	test('returns Run for initial request-only delta', () => {
		const processor = new BackgroundTodoProcessor();
		const result = processor.shouldRun(makeInput({
			promptContext: makePromptContext({ query: 'build an app' }),
		}));
		expect(result.decision).toBe(BackgroundTodoDecision.Run);
		expect(result.reason).toBe('ready');
		expect(result.delta!.metadata.isInitialDelta).toBe(true);
		expect(result.delta!.metadata.isRequestOnly).toBe(true);
	});

	test('returns Wait when processor is already InProgress', async () => {
		const processor = new BackgroundTodoProcessor();
		// Start a slow pass to put the processor into InProgress
		processor.start(
			{ userRequest: 'old', newRounds: [makeRound('r0')], history: [], sessionResource: undefined, metadata: { newRoundCount: 1, newToolCallCount: 1, isInitialDelta: true, isRequestOnly: false } },
			async () => {
				await new Promise(resolve => setTimeout(resolve, 200));
				return { outcome: 'success' };
			}
		);
		expect(processor.state).toBe(BackgroundTodoProcessorState.InProgress);

		// Now ask the policy with new activity
		const result = processor.shouldRun(makeInput({
			promptContext: makePromptContext({ toolCallRounds: [makeRound('r1')] }),
		}));
		expect(result.decision).toBe(BackgroundTodoDecision.Wait);
		expect(result.reason).toBe('processorInProgress');
		expect(result.delta).toBeDefined();

		processor.cancel();
	});

	test('delta from shouldRun contains metadata', () => {
		const processor = new BackgroundTodoProcessor();
		const result = processor.shouldRun(makeInput({
			promptContext: makePromptContext({ toolCallRounds: [makeRound('r1'), makeRound('r2')] }),
		}));
		expect(result.decision).toBe(BackgroundTodoDecision.Run);
		expect(result.delta!.metadata.newRoundCount).toBe(2);
		expect(result.delta!.metadata.newToolCallCount).toBe(2);
		expect(result.delta!.metadata.isInitialDelta).toBe(true);
		expect(result.delta!.metadata.isRequestOnly).toBe(false);
	});

	test('shouldRun does not advance the delta cursor', () => {
		const processor = new BackgroundTodoProcessor();
		const input = makeInput();
		const result1 = processor.shouldRun(input);
		const result2 = processor.shouldRun(input);
		expect(result1.decision).toBe(BackgroundTodoDecision.Run);
		expect(result2.decision).toBe(BackgroundTodoDecision.Run);
		expect(result2.delta!.newRounds).toHaveLength(1);
	});
});
