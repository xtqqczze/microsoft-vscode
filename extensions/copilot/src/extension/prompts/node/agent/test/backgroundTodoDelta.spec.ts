/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, test } from 'vitest';
import { BackgroundTodoDeltaTracker } from '../backgroundTodoDelta';
import { IBuildPromptContext, IToolCallRound } from '../../../../prompt/common/intents';

function makeRound(id: string): IToolCallRound {
	return {
		id,
		response: `response for ${id}`,
		toolInputRetry: 0,
		toolCalls: [{ name: 'read_file', arguments: '{}', id: `tc-${id}` }],
	};
}

function makePromptContext(opts: {
	query?: string;
	toolCallRounds?: IToolCallRound[];
	historyRounds?: IToolCallRound[][];
}): IBuildPromptContext {
	return {
		query: opts.query ?? 'fix the bug',
		history: (opts.historyRounds ?? []).map(rounds => ({
			rounds,
			request: { message: 'old request' },
		})) as any,
		chatVariables: { hasVariables: () => false } as any,
		toolCallRounds: opts.toolCallRounds,
	};
}

describe('BackgroundTodoDeltaTracker', () => {
	test('first invocation with no rounds returns delta with user request', () => {
		const tracker = new BackgroundTodoDeltaTracker();
		const ctx = makePromptContext({ query: 'add auth' });
		const delta = tracker.getDelta(ctx);
		expect(delta).toBeDefined();
		expect(delta!.userRequest).toBe('add auth');
		expect(delta!.newRounds).toHaveLength(0);
	});

	test('first invocation with rounds returns all rounds', () => {
		const tracker = new BackgroundTodoDeltaTracker();
		const r1 = makeRound('r1');
		const r2 = makeRound('r2');
		const ctx = makePromptContext({ toolCallRounds: [r1, r2] });
		const delta = tracker.getDelta(ctx);
		expect(delta).toBeDefined();
		expect(delta!.newRounds).toHaveLength(2);
	});

	test('marking processed prevents re-processing', () => {
		const tracker = new BackgroundTodoDeltaTracker();
		const r1 = makeRound('r1');
		const ctx = makePromptContext({ toolCallRounds: [r1] });

		const delta = tracker.getDelta(ctx)!;
		tracker.markProcessed(delta);

		const delta2 = tracker.getDelta(ctx);
		expect(delta2).toBeUndefined();
	});

	test('new rounds after marking previous ones are returned', () => {
		const tracker = new BackgroundTodoDeltaTracker();
		const r1 = makeRound('r1');
		const ctx1 = makePromptContext({ toolCallRounds: [r1] });

		const delta1 = tracker.getDelta(ctx1)!;
		tracker.markProcessed(delta1);

		const r2 = makeRound('r2');
		const ctx2 = makePromptContext({ toolCallRounds: [r1, r2] });
		const delta2 = tracker.getDelta(ctx2);
		expect(delta2).toBeDefined();
		expect(delta2!.newRounds).toHaveLength(1);
		expect(delta2!.newRounds[0].id).toBe('r2');
	});

	test('picks up rounds from history turns', () => {
		const tracker = new BackgroundTodoDeltaTracker();
		const r1 = makeRound('hist-r1');
		const ctx = makePromptContext({ historyRounds: [[r1]] });
		const delta = tracker.getDelta(ctx);
		expect(delta).toBeDefined();
		expect(delta!.newRounds).toHaveLength(1);
		expect(delta!.newRounds[0].id).toBe('hist-r1');
	});

	test('markRoundsProcessed advances cursor', () => {
		const tracker = new BackgroundTodoDeltaTracker();
		tracker.markRoundsProcessed(['r1', 'r2']);

		const r1 = makeRound('r1');
		const r2 = makeRound('r2');
		const r3 = makeRound('r3');
		const ctx = makePromptContext({ toolCallRounds: [r1, r2, r3] });
		const delta = tracker.getDelta(ctx);
		expect(delta).toBeDefined();
		expect(delta!.newRounds).toHaveLength(1);
		expect(delta!.newRounds[0].id).toBe('r3');
	});

	test('reset clears the processed set', () => {
		const tracker = new BackgroundTodoDeltaTracker();
		const r1 = makeRound('r1');
		const ctx = makePromptContext({ toolCallRounds: [r1] });

		tracker.markProcessed(tracker.getDelta(ctx)!);
		expect(tracker.getDelta(ctx)).toBeUndefined();

		tracker.reset();
		const delta = tracker.getDelta(ctx);
		expect(delta).toBeDefined();
		expect(delta!.newRounds).toHaveLength(1);
	});
});
