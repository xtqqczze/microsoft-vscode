/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, test } from 'vitest';
import { IToolCall, IToolCallRound } from '../../../../prompt/common/intents';
import { ToolName } from '../../../../tools/common/toolNames';
import {
	classifyTool,
	collectAllRounds,
	compressHistory,
	extractTarget,
	renderGroupedProgress,
	renderLatestRound,
} from '../backgroundTodoProcessor';

function makeCall(name: string, args: Record<string, unknown> = {}): IToolCall {
	return { name, arguments: JSON.stringify(args), id: `tc-${name}-${Math.random().toString(36).slice(2, 6)}` };
}

function makeRound(id: string, calls: IToolCall[], response = ''): IToolCallRound {
	return { id, response, toolInputRetry: 0, toolCalls: calls };
}

// ── classifyTool ────────────────────────────────────────────────

describe('classifyTool', () => {
	test('read-only tools are context', () => {
		expect(classifyTool(ToolName.ReadFile)).toBe('context');
		expect(classifyTool(ToolName.FindFiles)).toBe('context');
		expect(classifyTool(ToolName.FindTextInFiles)).toBe('context');
		expect(classifyTool(ToolName.ListDirectory)).toBe('context');
		expect(classifyTool(ToolName.GetErrors)).toBe('context');
		expect(classifyTool(ToolName.CoreScreenshotPage)).toBe('context');
	});

	test('mutating tools are meaningful', () => {
		expect(classifyTool(ToolName.ReplaceString)).toBe('meaningful');
		expect(classifyTool(ToolName.CreateFile)).toBe('meaningful');
		expect(classifyTool(ToolName.CoreRunInTerminal)).toBe('meaningful');
		expect(classifyTool(ToolName.CoreRunTest)).toBe('meaningful');
		expect(classifyTool(ToolName.ApplyPatch)).toBe('meaningful');
	});

	test('infrastructure tools are excluded', () => {
		expect(classifyTool(ToolName.CoreManageTodoList)).toBe('excluded');
		expect(classifyTool(ToolName.ToolSearch)).toBe('excluded');
		expect(classifyTool(ToolName.CoreAskQuestions)).toBe('excluded');
		expect(classifyTool(ToolName.CoreConfirmationTool)).toBe('excluded');
	});

	test('unknown tools default to meaningful', () => {
		expect(classifyTool('some_new_tool')).toBe('meaningful');
		expect(classifyTool('mcp_custom_server_action')).toBe('meaningful');
	});

	test('subagent tools are meaningful', () => {
		expect(classifyTool(ToolName.CoreRunSubagent)).toBe('meaningful');
		expect(classifyTool(ToolName.ExecutionSubagent)).toBe('meaningful');
		expect(classifyTool(ToolName.SearchSubagent)).toBe('meaningful');
	});
});

// ── extractTarget ───────────────────────────────────────────────

describe('extractTarget', () => {
	test('extracts filePath from read_file arguments', () => {
		const call = makeCall(ToolName.ReadFile, { filePath: 'src/app.ts', startLine: 1, endLine: 10 });
		expect(extractTarget(call)).toBe('src/app.ts');
	});

	test('extracts filePath from replace_string arguments', () => {
		const call = makeCall(ToolName.ReplaceString, { filePath: 'src/utils.ts', oldString: 'a', newString: 'b' });
		expect(extractTarget(call)).toBe('src/utils.ts');
	});

	test('terminal tools return "terminal"', () => {
		expect(extractTarget(makeCall(ToolName.CoreRunInTerminal))).toBe('terminal');
		expect(extractTarget(makeCall(ToolName.CoreGetTerminalOutput))).toBe('terminal');
		expect(extractTarget(makeCall(ToolName.CoreSendToTerminal))).toBe('terminal');
	});

	test('test/task tools return "tests/tasks"', () => {
		expect(extractTarget(makeCall(ToolName.CoreRunTest))).toBe('tests/tasks');
		expect(extractTarget(makeCall(ToolName.CoreRunTask))).toBe('tests/tasks');
	});

	test('falls back to tool name for unknown tools', () => {
		expect(extractTarget(makeCall('mcp_custom_action', { data: 123 }))).toBe('mcp_custom_action');
	});

	test('handles unparseable arguments gracefully', () => {
		const call: IToolCall = { name: ToolName.ReadFile, arguments: 'not json', id: 'tc-1' };
		expect(extractTarget(call)).toBe(ToolName.ReadFile);
	});

	test('subagent tools return appropriate categories', () => {
		expect(extractTarget(makeCall(ToolName.SearchSubagent))).toBe('search subagent');
		expect(extractTarget(makeCall(ToolName.CoreRunSubagent))).toBe('subagent');
	});
});

// ── collectAllRounds ────────────────────────────────────────────

describe('collectAllRounds', () => {
	test('combines history and current rounds in order', () => {
		const historyRound = makeRound('h1', [makeCall(ToolName.ReadFile)]);
		const currentRound = makeRound('c1', [makeCall(ToolName.CreateFile)]);
		const history = [{ rounds: [historyRound] }] as any;
		const result = collectAllRounds(history, [currentRound]);
		expect(result).toHaveLength(2);
		expect(result[0].id).toBe('h1');
		expect(result[1].id).toBe('c1');
	});

	test('handles empty history and current rounds', () => {
		expect(collectAllRounds([], [])).toHaveLength(0);
	});
});

// ── compressHistory ─────────────────────────────────────────────

describe('compressHistory', () => {
	test('returns empty history for no rounds', () => {
		const result = compressHistory([]);
		expect(result.groupedProgress).toHaveLength(0);
		expect(result.latestRound).toBeUndefined();
		expect(result.assistantContext).toHaveLength(0);
	});

	test('single round becomes latestRound with empty groups', () => {
		const round = makeRound('r1', [
			makeCall(ToolName.ReplaceString, { filePath: 'src/a.ts' }),
		], 'I updated the file');
		const result = compressHistory([round]);
		expect(result.groupedProgress).toHaveLength(0);
		expect(result.latestRound).toBeDefined();
		expect(result.latestRound!.toolSummaries).toHaveLength(1);
		expect(result.latestRound!.assistantResponse).toBe('I updated the file');
	});

	test('groups multiple rounds by file target', () => {
		const r1 = makeRound('r1', [
			makeCall(ToolName.ReadFile, { filePath: 'src/a.ts' }),
			makeCall(ToolName.ReplaceString, { filePath: 'src/a.ts' }),
		]);
		const r2 = makeRound('r2', [
			makeCall(ToolName.ReadFile, { filePath: 'src/b.ts' }),
		]);
		const r3 = makeRound('r3', [
			makeCall(ToolName.ReplaceString, { filePath: 'src/a.ts' }),
		], 'Latest response');

		const result = compressHistory([r1, r2, r3]);

		// r1 and r2 should be grouped; r3 is latestRound
		expect(result.groupedProgress).toHaveLength(2);
		// src/a.ts has 1 meaningful + 1 context, should sort first
		const aGroup = result.groupedProgress.find(g => g.target === 'src/a.ts');
		expect(aGroup).toBeDefined();
		expect(aGroup!.meaningfulCalls).toContain(ToolName.ReplaceString);
		expect(aGroup!.contextCallCount).toBe(1);
		// src/b.ts has only context
		const bGroup = result.groupedProgress.find(g => g.target === 'src/b.ts');
		expect(bGroup).toBeDefined();
		expect(bGroup!.contextCallCount).toBe(1);
		expect(bGroup!.meaningfulCalls).toHaveLength(0);

		expect(result.latestRound!.assistantResponse).toBe('Latest response');
	});

	test('sorts meaningful-heavy groups first', () => {
		const r1 = makeRound('r1', [
			makeCall(ToolName.ReadFile, { filePath: 'src/read-only.ts' }),
			makeCall(ToolName.ReadFile, { filePath: 'src/read-only.ts' }),
			makeCall(ToolName.ReplaceString, { filePath: 'src/edited.ts' }),
			makeCall(ToolName.CreateFile, { filePath: 'src/edited.ts' }),
		]);
		const r2 = makeRound('r2', [makeCall(ToolName.ReadFile, { filePath: 'src/latest.ts' })]);
		const result = compressHistory([r1, r2]);

		// src/edited.ts (2 meaningful) should come before src/read-only.ts (0 meaningful, 2 context)
		expect(result.groupedProgress[0].target).toBe('src/edited.ts');
	});

	test('excludes infrastructure tool calls from groups', () => {
		const r1 = makeRound('r1', [
			makeCall(ToolName.CoreManageTodoList),
			makeCall(ToolName.ToolSearch),
			makeCall(ToolName.ReplaceString, { filePath: 'src/a.ts' }),
		]);
		const r2 = makeRound('r2', [makeCall(ToolName.ReadFile, { filePath: 'src/a.ts' })]);
		const result = compressHistory([r1, r2]);

		// Only src/a.ts group, no manage_todo_list or tool_search groups
		expect(result.groupedProgress).toHaveLength(1);
		expect(result.groupedProgress[0].target).toBe('src/a.ts');
		expect(result.groupedProgress[0].totalCalls).toBe(1); // only the replace_string
	});

	test('excludes infrastructure tools from latestRound summaries', () => {
		const round = makeRound('r1', [
			makeCall(ToolName.CoreManageTodoList),
			makeCall(ToolName.ReplaceString, { filePath: 'src/a.ts' }),
		]);
		const result = compressHistory([round]);
		expect(result.latestRound!.toolSummaries).toHaveLength(1);
		expect(result.latestRound!.toolSummaries[0].name).toBe(ToolName.ReplaceString);
	});

	test('truncates long assistant responses', () => {
		const longResponse = 'x'.repeat(1000);
		const round = makeRound('r1', [makeCall(ToolName.ReadFile, { filePath: 'a.ts' })], longResponse);
		const result = compressHistory([round]);
		expect(result.latestRound!.assistantResponse.length).toBeLessThanOrEqual(401); // 400 + '…'
	});

	test('extracts assistant context from latest and first round', () => {
		const r1 = makeRound('r1', [makeCall(ToolName.ReadFile, { filePath: 'a.ts' })], 'First response');
		const r2 = makeRound('r2', [makeCall(ToolName.ReadFile, { filePath: 'b.ts' })], 'Middle response');
		const r3 = makeRound('r3', [makeCall(ToolName.ReadFile, { filePath: 'c.ts' })], 'Latest response');
		const result = compressHistory([r1, r2, r3]);
		expect(result.assistantContext).toHaveLength(2);
		expect(result.assistantContext[0]).toBe('Latest response');
		expect(result.assistantContext[1]).toBe('First response');
	});

	test('skips empty assistant responses in context', () => {
		const r1 = makeRound('r1', [makeCall(ToolName.ReadFile, { filePath: 'a.ts' })], '');
		const r2 = makeRound('r2', [makeCall(ToolName.ReadFile, { filePath: 'b.ts' })], 'Only response');
		const result = compressHistory([r1, r2]);
		// Latest has response, first is empty → only 1 context entry
		expect(result.assistantContext).toHaveLength(1);
		expect(result.assistantContext[0]).toBe('Only response');
	});
});

// ── renderGroupedProgress ───────────────────────────────────────

describe('renderGroupedProgress', () => {
	test('renders empty string for no groups', () => {
		expect(renderGroupedProgress([])).toBe('');
	});

	test('renders meaningful calls and context count', () => {
		const groups = [{
			target: 'src/app.ts',
			meaningfulCalls: [ToolName.ReplaceString, ToolName.ReplaceString],
			contextCallCount: 3,
			totalCalls: 5,
		}];
		const text = renderGroupedProgress(groups);
		expect(text).toContain('[src/app.ts]');
		expect(text).toContain('Actions:');
		expect(text).toContain('(3 reads)');
	});

	test('deduplicates tool names within a group', () => {
		const groups = [{
			target: 'src/app.ts',
			meaningfulCalls: [ToolName.ReplaceString, ToolName.ReplaceString, ToolName.CreateFile],
			contextCallCount: 0,
			totalCalls: 3,
		}];
		const text = renderGroupedProgress(groups);
		// Should appear once each, not duplicated
		const matches = text.match(new RegExp(ToolName.ReplaceString, 'g'));
		expect(matches).toHaveLength(1);
	});
});

// ── renderLatestRound ───────────────────────────────────────────

describe('renderLatestRound', () => {
	test('renders tool summaries with targets', () => {
		const detail = {
			toolSummaries: [
				{ name: ToolName.ReplaceString, target: 'src/app.ts' },
				{ name: ToolName.CoreRunInTerminal, target: 'terminal' },
			],
			assistantResponse: 'I fixed the issue',
		};
		const text = renderLatestRound(detail);
		expect(text).toContain(`- ${ToolName.ReplaceString} → src/app.ts`);
		expect(text).toContain(`- ${ToolName.CoreRunInTerminal} → terminal`);
		expect(text).toContain('Agent said: I fixed the issue');
	});

	test('renders without agent response when empty', () => {
		const detail = {
			toolSummaries: [{ name: ToolName.ReadFile, target: 'src/a.ts' }],
			assistantResponse: '',
		};
		const text = renderLatestRound(detail);
		expect(text).not.toContain('Agent said');
	});
});
