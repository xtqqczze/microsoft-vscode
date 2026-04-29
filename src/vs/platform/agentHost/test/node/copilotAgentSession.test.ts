/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CopilotSession, SessionEvent, SessionEventPayload, SessionEventType, Tool, ToolResultObject, TypedSessionEventHandler } from '@github/copilot-sdk';
import assert from 'assert';
import { DeferredPromise } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { join, sep } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { INativeEnvironmentService } from '../../../environment/common/environment.js';
import { IFileService } from '../../../files/common/files.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../instantiation/common/serviceCollection.js';
import { ILogService, NullLogService } from '../../../log/common/log.js';
import { AgentSession, type AgentSignal, type IAgentActionSignal, type IAgentToolPendingConfirmationSignal } from '../../common/agentService.js';
import { IDiffComputeService } from '../../common/diffComputeService.js';
import { ISessionDataService } from '../../common/sessionDataService.js';
import { ActionType, type SessionDeltaAction, type SessionErrorAction, type SessionInputRequestedAction, type SessionResponsePartAction, type SessionToolCallCompleteAction, type SessionToolCallReadyAction, type SessionToolCallStartAction } from '../../common/state/sessionActions.js';
import { AttachmentType, ResponsePartKind, SessionInputAnswerState, SessionInputAnswerValueKind, SessionInputQuestionKind, SessionInputResponseKind, ToolResultContentType } from '../../common/state/sessionState.js';
import { CopilotAgentSession, IActiveClientSnapshot, SessionWrapperFactory } from '../../node/copilot/copilotAgentSession.js';
import { CopilotSessionWrapper } from '../../node/copilot/copilotSessionWrapper.js';
import { createSessionDataService, createZeroDiffComputeService } from '../common/sessionTestHelpers.js';

// ---- Mock CopilotSession (SDK level) ----------------------------------------

/**
 * Minimal mock of the SDK's {@link CopilotSession}. Implements `on()` to
 * store typed handlers, and exposes `fire()` so tests can push events
 * through the real {@link CopilotSessionWrapper} event pipeline.
 */
class MockCopilotSession {
	readonly sessionId = 'test-session-1';
	readonly sendRequests: unknown[] = [];

	private readonly _handlers = new Map<string, Set<(event: SessionEvent) => void>>();

	on<K extends SessionEventType>(eventType: K, handler: TypedSessionEventHandler<K>): () => void {
		let set = this._handlers.get(eventType);
		if (!set) {
			set = new Set();
			this._handlers.set(eventType, set);
		}
		set.add(handler as (event: SessionEvent) => void);
		return () => { set.delete(handler as (event: SessionEvent) => void); };
	}

	/** Push an event through to all registered handlers of the given type. */
	fire<K extends SessionEventType>(type: K, data: SessionEventPayload<K>['data']): void {
		const event = { type, data, id: 'evt-1', timestamp: new Date().toISOString(), parentId: null } as SessionEventPayload<K>;
		const set = this._handlers.get(type);
		if (set) {
			for (const handler of set) {
				handler(event);
			}
		}
	}

	// Stubs for methods the wrapper / session class calls
	async send(request: unknown) { this.sendRequests.push(request); return ''; }
	async abort() { }
	async setModel() { }
	async getMessages() { return []; }
	async destroy() { }
}

class CapturingLogService extends NullLogService {
	readonly errors: Array<{ first: string | Error; args: unknown[] }> = [];

	override error(message: string | Error, ...args: unknown[]): void {
		this.errors.push({ first: message, args });
		super.error(message, ...args);
	}
}

// ---- Helpers ----------------------------------------------------------------

/**
 * Invokes a client-SDK tool's handler with the minimal fields the SDK
 * contract requires, and narrows the `unknown` return type to
 * {@link ToolResultObject} — which is what {@link CopilotAgentSession}'s
 * handler implementation actually returns.
 */
function invokeClientToolHandler(tool: Pick<Tool, 'name' | 'handler'>, toolCallId: string, args: Record<string, unknown> = {}): Promise<ToolResultObject> {
	return Promise.resolve(tool.handler(args, {
		sessionId: 'test-session-1',
		toolCallId,
		toolName: tool.name,
		arguments: args,
	})) as Promise<ToolResultObject>;
}

type ISessionInternalsForTest = {
	_onDidSessionProgress: { fire(event: AgentSignal): void };
	_editTracker: {
		trackEditStart(path: string): Promise<void>;
		completeEdit(path: string): Promise<void>;
	};
	_pendingClientToolCalls: {
		get(toolCallId: string): DeferredPromise<ToolResultObject> | undefined;
		set(toolCallId: string, value: DeferredPromise<ToolResultObject>): Map<string, DeferredPromise<ToolResultObject>>;
		delete(toolCallId: string): boolean;
	};
};

function isAction(s: AgentSignal, type: ActionType): s is IAgentActionSignal {
	return s.kind === 'action' && s.action.type === type;
}

function getInputRequest(signal: AgentSignal): SessionInputRequestedAction['request'] {
	assert.strictEqual(signal.kind, 'action');
	if (signal.kind !== 'action') { throw new Error('unreachable'); }
	assert.strictEqual(signal.action.type, ActionType.SessionInputRequested);
	return (signal.action as SessionInputRequestedAction).request;
}

async function createAgentSession(disposables: DisposableStore, options?: {
	clientSnapshot?: IActiveClientSnapshot;
	environmentServiceRegistration?: 'native' | 'none';
	logService?: ILogService;
	captureWrapperCallbacks?: { current?: Parameters<SessionWrapperFactory>[0] };
	workingDirectory?: URI;
}): Promise<{
	session: CopilotAgentSession;
	mockSession: MockCopilotSession;
	signals: AgentSignal[];
	waitForSignal: (predicate: (signal: AgentSignal) => boolean) => Promise<AgentSignal>;
}> {
	const progressEmitter = disposables.add(new Emitter<AgentSignal>());
	const signals: AgentSignal[] = [];
	const waiters: { predicate: (signal: AgentSignal) => boolean; deferred: DeferredPromise<AgentSignal> }[] = [];

	disposables.add(progressEmitter.event(signal => {
		signals.push(signal);
		for (let i = waiters.length - 1; i >= 0; i--) {
			if (waiters[i].predicate(signal)) {
				const { deferred } = waiters[i];
				waiters.splice(i, 1);
				deferred.complete(signal);
			}
		}
	}));

	const waitForSignal = (predicate: (signal: AgentSignal) => boolean): Promise<AgentSignal> => {
		const existing = signals.find(predicate);
		if (existing) {
			return Promise.resolve(existing);
		}
		const deferred = new DeferredPromise<AgentSignal>();
		waiters.push({ predicate, deferred });
		return deferred.p;
	};

	const sessionUri = AgentSession.uri('copilot', 'test-session-1');
	const mockSession = new MockCopilotSession();

	const factory: SessionWrapperFactory = async callbacks => {
		if (options?.captureWrapperCallbacks) {
			options.captureWrapperCallbacks.current = callbacks;
		}
		return new CopilotSessionWrapper(mockSession as unknown as CopilotSession);
	};

	const services = new ServiceCollection();
	services.set(ILogService, options?.logService ?? new NullLogService());
	services.set(IFileService, { _serviceBrand: undefined } as IFileService);
	services.set(ISessionDataService, createSessionDataService());
	services.set(IDiffComputeService, createZeroDiffComputeService());
	const environmentService = {
		_serviceBrand: undefined,
		userHome: URI.file('/mock-home'),
	} as INativeEnvironmentService;
	if (options?.environmentServiceRegistration !== 'none') {
		services.set(INativeEnvironmentService, environmentService);
	}
	const instantiationService = disposables.add(new InstantiationService(services));

	const session = disposables.add(instantiationService.createInstance(
		CopilotAgentSession,
		{
			sessionUri,
			rawSessionId: 'test-session-1',
			onDidSessionProgress: progressEmitter,
			wrapperFactory: factory,
			shellManager: undefined,
			clientSnapshot: options?.clientSnapshot,
			workingDirectory: options?.workingDirectory,
		},
	));

	await session.initializeSession();

	return { session, mockSession, signals, waitForSignal };
}

// ---- Tests ------------------------------------------------------------------

suite('CopilotAgentSession', () => {

	const disposables = new DisposableStore();

	teardown(() => disposables.clear());
	ensureNoDisposablesAreLeakedInTestSuite();

	test('maps internal attachment URIs to Copilot SDK path fields', async () => {
		const { session, mockSession } = await createAgentSession(disposables);
		const fileUri = URI.file('/workspace/file.ts');
		const selectionUri = URI.file('/workspace/selection.ts');

		await session.send('hello', [
			{ type: AttachmentType.File, uri: fileUri, displayName: 'file.ts' },
			{ type: AttachmentType.Selection, uri: selectionUri, displayName: 'selection.ts' },
		]);

		assert.deepStrictEqual(mockSession.sendRequests, [{
			prompt: 'hello',
			attachments: [
				{ type: 'file', path: fileUri.fsPath, displayName: 'file.ts' },
				{ type: 'selection', filePath: selectionUri.fsPath, displayName: 'selection.ts', text: undefined, selection: undefined },
			],
		}]);
	});

	// ---- permission handling ----

	suite('permission handling', () => {

		test('read permission fires tool_ready (deferred to side effects)', async () => {
			const { session, signals, waitForSignal } = await createAgentSession(disposables);
			const resultPromise = session.handlePermissionRequest({
				kind: 'read',
				path: '/workspace/src/file.ts',
				toolCallId: 'tc-1',
			});

			await waitForSignal(s => s.kind === 'pending_confirmation');
			assert.strictEqual(signals.length, 1);

			assert.ok(session.respondToPermissionRequest('tc-1', true));
			const result = await resultPromise;
			assert.strictEqual(result.kind, 'approved');
		});

		test('auto-approves read permission for session-state plan files', async () => {
			const previousXdgStateHome = process.env['XDG_STATE_HOME'];
			process.env['XDG_STATE_HOME'] = '/mock-state-home';
			try {
				const { session, signals } = await createAgentSession(disposables);
				const result = await session.handlePermissionRequest({
					kind: 'read',
					path: join('/mock-state-home', '.copilot', 'session-state', 'test-session-1', 'plan.md'),
					toolCallId: 'tc-read-plan',
				});

				assert.strictEqual(result.kind, 'approved');
				assert.strictEqual(signals.length, 0);
			} finally {
				if (previousXdgStateHome === undefined) {
					delete process.env['XDG_STATE_HOME'];
				} else {
					process.env['XDG_STATE_HOME'] = previousXdgStateHome;
				}
			}
		});

		test('resolves native environment through INativeEnvironmentService registration', async () => {
			const previousXdgStateHome = process.env['XDG_STATE_HOME'];
			delete process.env['XDG_STATE_HOME'];
			try {
				const { session, signals } = await createAgentSession(disposables, { environmentServiceRegistration: 'native' });
				const result = await session.handlePermissionRequest({
					kind: 'read',
					path: join('/mock-home', '.copilot', 'session-state', 'test-session-1', 'plan.md'),
					toolCallId: 'tc-read-plan-native-env',
				});

				assert.strictEqual(result.kind, 'approved');
				assert.strictEqual(signals.length, 0);
			} finally {
				if (previousXdgStateHome === undefined) {
					delete process.env['XDG_STATE_HOME'];
				} else {
					process.env['XDG_STATE_HOME'] = previousXdgStateHome;
				}
			}
		});

		test('logs and rethrows permission failures', async () => {
			const previousXdgStateHome = process.env['XDG_STATE_HOME'];
			delete process.env['XDG_STATE_HOME'];
			const logService = new CapturingLogService();
			try {
				const { session } = await createAgentSession(disposables, {
					environmentServiceRegistration: 'none',
					logService,
				});

				await assert.rejects(
					session.handlePermissionRequest({
						kind: 'read',
						path: join('/mock-home', '.copilot', 'session-state', 'test-session-1', 'plan.md'),
						toolCallId: 'tc-read-plan-missing-env',
					}),
				);

				assert.strictEqual(logService.errors.length, 1);
				const [entry] = logService.errors;
				assert.ok(entry.first instanceof TypeError);
				assert.strictEqual(entry.args[0], '[Copilot:test-session-1] Failed to handle permission request: kind=read, toolCallId=tc-read-plan-missing-env');
			} finally {
				if (previousXdgStateHome === undefined) {
					delete process.env['XDG_STATE_HOME'];
				} else {
					process.env['XDG_STATE_HOME'] = previousXdgStateHome;
				}
			}
		});

		test('write permission fires tool_ready (deferred to side effects)', async () => {
			const { session, signals, waitForSignal } = await createAgentSession(disposables);
			const resultPromise = session.handlePermissionRequest({
				kind: 'write',
				fileName: '/workspace/src/file.ts',
				toolCallId: 'tc-1',
			});

			await waitForSignal(s => s.kind === 'pending_confirmation');
			assert.strictEqual(signals.length, 1);

			assert.ok(session.respondToPermissionRequest('tc-1', true));
			const result = await resultPromise;
			assert.strictEqual(result.kind, 'approved');
		});

		test('auto-approves write permission for session-state plan files', async () => {
			const previousXdgStateHome = process.env['XDG_STATE_HOME'];
			process.env['XDG_STATE_HOME'] = '/mock-state-home';
			try {
				const { session, signals } = await createAgentSession(disposables);
				const result = await session.handlePermissionRequest({
					kind: 'write',
					fileName: join('/mock-state-home', '.copilot', 'session-state', 'test-session-1', 'plan.md'),
					toolCallId: 'tc-write-plan',
				});

				assert.strictEqual(result.kind, 'approved');
				assert.strictEqual(signals.length, 0);
			} finally {
				if (previousXdgStateHome === undefined) {
					delete process.env['XDG_STATE_HOME'];
				} else {
					process.env['XDG_STATE_HOME'] = previousXdgStateHome;
				}
			}
		});

		test('does not auto-approve session-state files from another session', async () => {
			const previousXdgStateHome = process.env['XDG_STATE_HOME'];
			process.env['XDG_STATE_HOME'] = '/mock-state-home';
			try {
				const { session, signals, waitForSignal } = await createAgentSession(disposables);
				const resultPromise = session.handlePermissionRequest({
					kind: 'write',
					fileName: join('/mock-state-home', '.copilot', 'session-state', 'different-session', 'plan.md'),
					toolCallId: 'tc-write-other-plan',
				});

				await waitForSignal(s => s.kind === 'pending_confirmation');
				assert.strictEqual(signals.length, 1);

				assert.ok(session.respondToPermissionRequest('tc-write-other-plan', true));
				const result = await resultPromise;
				assert.strictEqual(result.kind, 'approved');
			} finally {
				if (previousXdgStateHome === undefined) {
					delete process.env['XDG_STATE_HOME'];
				} else {
					process.env['XDG_STATE_HOME'] = previousXdgStateHome;
				}
			}
		});

		test('does not auto-approve traversal paths that escape the session-state directory', async () => {
			const previousXdgStateHome = process.env['XDG_STATE_HOME'];
			process.env['XDG_STATE_HOME'] = '/mock-state-home';
			try {
				const { session, signals, waitForSignal } = await createAgentSession(disposables);
				const sessionDir = join('/mock-state-home', '.copilot', 'session-state', 'test-session-1');
				const resultPromise = session.handlePermissionRequest({
					kind: 'write',
					fileName: `${sessionDir}${sep}..${sep}outside.md`,
					toolCallId: 'tc-write-traversal',
				});

				await waitForSignal(s => s.kind === 'pending_confirmation');
				assert.strictEqual(signals.length, 1);

				assert.ok(session.respondToPermissionRequest('tc-write-traversal', true));
				const result = await resultPromise;
				assert.strictEqual(result.kind, 'approved');
			} finally {
				if (previousXdgStateHome === undefined) {
					delete process.env['XDG_STATE_HOME'];
				} else {
					process.env['XDG_STATE_HOME'] = previousXdgStateHome;
				}
			}
		});

		test('write permission outside working directory fires tool_ready', async () => {
			const { session, signals, waitForSignal } = await createAgentSession(disposables);

			const resultPromise = session.handlePermissionRequest({
				kind: 'write',
				fileName: '/other/file.ts',
				toolCallId: 'tc-write-outside',
			});

			await waitForSignal(s => s.kind === 'pending_confirmation');
			assert.strictEqual(signals.length, 1);

			assert.ok(session.respondToPermissionRequest('tc-write-outside', true));
			const result = await resultPromise;
			assert.strictEqual(result.kind, 'approved');
		});

		test('read permission outside working directory fires tool_ready', async () => {
			const { session, signals, waitForSignal } = await createAgentSession(disposables);

			// Kick off permission request but don't await — it will block
			const resultPromise = session.handlePermissionRequest({
				kind: 'read',
				path: '/other/file.ts',
				toolCallId: 'tc-2',
			});

			// Should have fired a pending_confirmation signal
			await waitForSignal(s => s.kind === 'pending_confirmation');
			assert.strictEqual(signals.length, 1);

			// Respond to it
			assert.ok(session.respondToPermissionRequest('tc-2', true));
			const result = await resultPromise;
			assert.strictEqual(result.kind, 'approved');
		});

		test('denies permission when no toolCallId', async () => {
			const { session } = await createAgentSession(disposables);
			const result = await session.handlePermissionRequest({ kind: 'write' });
			assert.strictEqual(result.kind, 'denied-interactively-by-user');
		});

		test('denied-interactively when user denies', async () => {
			const { session, signals, waitForSignal } = await createAgentSession(disposables);
			const resultPromise = session.handlePermissionRequest({
				kind: 'shell',
				toolCallId: 'tc-3',
			});

			await waitForSignal(s => s.kind === 'pending_confirmation');
			assert.strictEqual(signals.length, 1);
			session.respondToPermissionRequest('tc-3', false);
			const result = await resultPromise;
			assert.strictEqual(result.kind, 'denied-interactively-by-user');
		});

		test('pending permissions are denied on dispose', async () => {
			const { session } = await createAgentSession(disposables);
			const resultPromise = session.handlePermissionRequest({
				kind: 'write',
				toolCallId: 'tc-4',
			});

			session.dispose();
			const result = await resultPromise;
			assert.strictEqual(result.kind, 'denied-interactively-by-user');
		});

		test('pending permissions are denied on abort', async () => {
			const { session } = await createAgentSession(disposables);
			const resultPromise = session.handlePermissionRequest({
				kind: 'write',
				toolCallId: 'tc-5',
			});

			await session.abort();
			const result = await resultPromise;
			assert.strictEqual(result.kind, 'denied-interactively-by-user');
		});

		test('respondToPermissionRequest returns false for unknown id', async () => {
			const { session } = await createAgentSession(disposables);
			assert.strictEqual(session.respondToPermissionRequest('unknown-id', true), false);
		});
	});

	// ---- sendSteering ----

	suite('sendSteering', () => {

		test('fires steering_consumed after send resolves', async () => {
			const { session, signals } = await createAgentSession(disposables);

			await session.sendSteering({ id: 'steer-1', userMessage: { text: 'focus on tests' } });

			const consumed = signals.find(s => s.kind === 'steering_consumed');
			assert.ok(consumed, 'should fire steering_consumed signal');
			assert.strictEqual((consumed as { id: string }).id, 'steer-1');
		});

		test('does not fire steering_consumed when send fails', async () => {
			const { session, mockSession, signals } = await createAgentSession(disposables);

			mockSession.send = async () => { throw new Error('send failed'); };

			await session.sendSteering({ id: 'steer-fail', userMessage: { text: 'will fail' } });

			const consumed = signals.find(s => s.kind === 'steering_consumed');
			assert.strictEqual(consumed, undefined, 'should not fire steering_consumed on failure');
		});
	});

	// ---- event mapping ----

	suite('event mapping', () => {

		test('tool_start event is mapped for non-hidden tools', async () => {
			const { mockSession, signals } = await createAgentSession(disposables);
			mockSession.fire('tool.execution_start', {
				toolCallId: 'tc-10',
				toolName: 'bash',
				arguments: { command: 'echo hello' },
			} as SessionEventPayload<'tool.execution_start'>['data']);

			assert.strictEqual(signals.length, 2);
			const toolStart = signals[0];
			assert.ok(isAction(toolStart, ActionType.SessionToolCallStart));
			if (isAction(toolStart, ActionType.SessionToolCallStart)) {
				const action = toolStart.action as SessionToolCallStartAction;
				assert.strictEqual(action.toolCallId, 'tc-10');
				assert.strictEqual(action.toolName, 'bash');
			}
		});

		test('live tool_start strips redundant cd prefix matching workingDirectory', async () => {
			const wd = URI.file('/repo/project');
			const { mockSession, signals } = await createAgentSession(disposables, { workingDirectory: wd });
			mockSession.fire('tool.execution_start', {
				toolCallId: 'tc-cd',
				toolName: 'bash',
				arguments: { command: 'cd /repo/project && npm test' },
			} as SessionEventPayload<'tool.execution_start'>['data']);

			assert.strictEqual(signals.length, 2);
			// toolInput on the auto-ready signal (signals[1])
			const readySignal = signals[1];
			assert.ok(isAction(readySignal, ActionType.SessionToolCallReady));
			if (isAction(readySignal, ActionType.SessionToolCallReady)) {
				const action = readySignal.action as SessionToolCallReadyAction;
				assert.strictEqual(action.toolInput, 'npm test');
			}
			// toolArguments in _meta on the tool_start signal (signals[0])
			const startSignal = signals[0];
			assert.ok(isAction(startSignal, ActionType.SessionToolCallStart));
			if (isAction(startSignal, ActionType.SessionToolCallStart)) {
				const meta = (startSignal.action as SessionToolCallStartAction)._meta;
				const toolArgs = meta?.['toolArguments'] as string | undefined;
				assert.ok(toolArgs && toolArgs.includes('"npm test"'), `toolArguments should contain rewritten command, was: ${toolArgs}`);
				assert.ok(!toolArgs?.includes('cd /repo/project'), 'toolArguments should not contain stripped prefix');
			}
		});

		test('live tool_complete past-tense message reflects the rewritten command', async () => {
			const wd = URI.file('/repo/project');
			const { mockSession, signals } = await createAgentSession(disposables, { workingDirectory: wd });

			mockSession.fire('tool.execution_start', {
				toolCallId: 'tc-cd-complete',
				toolName: 'bash',
				arguments: { command: 'cd /repo/project && npm test' },
			} as SessionEventPayload<'tool.execution_start'>['data']);

			mockSession.fire('tool.execution_complete', {
				toolCallId: 'tc-cd-complete',
				success: true,
				result: { content: 'all tests passed' },
			} as SessionEventPayload<'tool.execution_complete'>['data']);

			assert.strictEqual(signals.length, 3);
			const completeSignal = signals[2];
			assert.ok(isAction(completeSignal, ActionType.SessionToolCallComplete));
			if (isAction(completeSignal, ActionType.SessionToolCallComplete)) {
				const action = completeSignal.action as SessionToolCallCompleteAction;
				const past = action.result.pastTenseMessage;
				const pastStr = typeof past === 'string' ? past : (past?.markdown ?? '');
				assert.ok(!pastStr.includes('cd /repo/project'), `past-tense message should not contain stripped prefix, got: ${pastStr}`);
				assert.ok(pastStr.includes('npm test'), `past-tense message should contain the rewritten command, got: ${pastStr}`);
			}
		});

		test('live tool_start does not rewrite when cd target differs from workingDirectory', async () => {
			const wd = URI.file('/repo/project');
			const { mockSession, signals } = await createAgentSession(disposables, { workingDirectory: wd });
			mockSession.fire('tool.execution_start', {
				toolCallId: 'tc-cd-other',
				toolName: 'bash',
				arguments: { command: 'cd /tmp && ls' },
			} as SessionEventPayload<'tool.execution_start'>['data']);

			assert.strictEqual(signals.length, 2);
			const readySignal = signals[1];
			assert.ok(isAction(readySignal, ActionType.SessionToolCallReady));
			if (isAction(readySignal, ActionType.SessionToolCallReady)) {
				assert.strictEqual((readySignal.action as SessionToolCallReadyAction).toolInput, 'cd /tmp && ls');
			}
		});

		test('live tool_start without workingDirectory passes command through', async () => {
			const { mockSession, signals } = await createAgentSession(disposables);
			mockSession.fire('tool.execution_start', {
				toolCallId: 'tc-cd-nowd',
				toolName: 'bash',
				arguments: { command: 'cd /repo/project && npm test' },
			} as SessionEventPayload<'tool.execution_start'>['data']);

			assert.strictEqual(signals.length, 2);
			const readySignal = signals[1];
			assert.ok(isAction(readySignal, ActionType.SessionToolCallReady));
			if (isAction(readySignal, ActionType.SessionToolCallReady)) {
				assert.strictEqual((readySignal.action as SessionToolCallReadyAction).toolInput, 'cd /repo/project && npm test');
			}
		});

		test('hidden tools are not emitted as tool_start', async () => {
			const { mockSession, signals } = await createAgentSession(disposables);
			mockSession.fire('tool.execution_start', {
				toolCallId: 'tc-11',
				toolName: 'report_intent',
			} as SessionEventPayload<'tool.execution_start'>['data']);

			assert.strictEqual(signals.length, 0);
		});

		test('tool_complete event produces past-tense message', async () => {
			const { mockSession, signals } = await createAgentSession(disposables);

			// First fire tool_start so it's tracked
			mockSession.fire('tool.execution_start', {
				toolCallId: 'tc-12',
				toolName: 'bash',
				arguments: { command: 'ls' },
			} as SessionEventPayload<'tool.execution_start'>['data']);

			// Then fire complete
			mockSession.fire('tool.execution_complete', {
				toolCallId: 'tc-12',
				success: true,
				result: { content: 'file1.ts\nfile2.ts' },
			} as SessionEventPayload<'tool.execution_complete'>['data']);

			assert.strictEqual(signals.length, 3);
			const completeSignal = signals[2];
			assert.ok(isAction(completeSignal, ActionType.SessionToolCallComplete));
			if (isAction(completeSignal, ActionType.SessionToolCallComplete)) {
				const action = completeSignal.action as SessionToolCallCompleteAction;
				assert.strictEqual(action.toolCallId, 'tc-12');
				assert.ok(action.result.success);
				assert.ok(action.result.pastTenseMessage);
			}
		});

		test('tool_complete for untracked tool is ignored', async () => {
			const { mockSession, signals } = await createAgentSession(disposables);
			mockSession.fire('tool.execution_complete', {
				toolCallId: 'tc-untracked',
				success: true,
			} as SessionEventPayload<'tool.execution_complete'>['data']);

			assert.strictEqual(signals.length, 0);
		});

		test('idle event is forwarded', async () => {
			const { mockSession, signals } = await createAgentSession(disposables);
			mockSession.fire('session.idle', {} as SessionEventPayload<'session.idle'>['data']);

			assert.strictEqual(signals.length, 1);
			assert.ok(isAction(signals[0], ActionType.SessionTurnComplete));
		});

		test('error event is forwarded', async () => {
			const { mockSession, signals } = await createAgentSession(disposables);
			mockSession.fire('session.error', {
				errorType: 'TestError',
				message: 'something went wrong',
				stack: 'Error: something went wrong',
			} as SessionEventPayload<'session.error'>['data']);

			assert.strictEqual(signals.length, 1);
			assert.ok(isAction(signals[0], ActionType.SessionError));
			if (isAction(signals[0], ActionType.SessionError)) {
				const action = signals[0].action as SessionErrorAction;
				assert.strictEqual(action.error.errorType, 'TestError');
				assert.strictEqual(action.error.message, 'something went wrong');
			}
		});

		test('message delta is forwarded', async () => {
			const { mockSession, signals } = await createAgentSession(disposables);
			mockSession.fire('assistant.message_delta', {
				messageId: 'msg-1',
				deltaContent: 'Hello ',
			} as SessionEventPayload<'assistant.message_delta'>['data']);

			assert.ok(signals.length >= 1);
			const hasDelta = signals.some(s => {
				if (s.kind !== 'action') { return false; }
				if (s.action.type === ActionType.SessionResponsePart) {
					const part = (s.action as SessionResponsePartAction).part;
					return part.kind === ResponsePartKind.Markdown && part.content === 'Hello ';
				}
				if (s.action.type === ActionType.SessionDelta) {
					return (s.action as SessionDeltaAction).content === 'Hello ';
				}
				return false;
			});
			assert.ok(hasDelta, 'should have forwarded the delta content');
		});

		test('complete assistant message without preceding deltas surfaces a markdown response part', async () => {
			const { mockSession, signals } = await createAgentSession(disposables);
			mockSession.fire('assistant.message', {
				messageId: 'msg-2',
				content: 'Let me help you.',
				toolRequests: [{
					toolCallId: 'tc-20',
					name: 'bash',
					arguments: { command: 'ls' },
					type: 'function',
				}],
			} as SessionEventPayload<'assistant.message'>['data']);

			// The session emits a fresh markdown response part for the
			// content. Tool calls fire their own events, so
			// `toolRequests` on the assistant message are not forwarded
			// during live streaming.
			assert.ok(signals.length >= 1);
			const hasPart = signals.some(s => {
				if (s.kind !== 'action') { return false; }
				if (s.action.type === ActionType.SessionResponsePart) {
					const part = (s.action as SessionResponsePartAction).part;
					return part.kind === ResponsePartKind.Markdown && part.content === 'Let me help you.';
				}
				if (s.action.type === ActionType.SessionDelta) {
					return (s.action as SessionDeltaAction).content === 'Let me help you.';
				}
				return false;
			});
			assert.ok(hasPart, 'should have surfaced the message content');
		});

		test('reasoning delta after tool_start starts a new reasoning response part', async () => {
			const { mockSession, signals } = await createAgentSession(disposables);

			// First reasoning delta — allocates a fresh reasoning response part.
			mockSession.fire('assistant.reasoning_delta', {
				deltaContent: 'thinking step 1',
			} as SessionEventPayload<'assistant.reasoning_delta'>['data']);

			// A tool call interleaves between reasoning rounds.
			mockSession.fire('tool.execution_start', {
				toolCallId: 'tc-r-1',
				toolName: 'bash',
				arguments: { command: 'echo hi' },
			} as SessionEventPayload<'tool.execution_start'>['data']);
			mockSession.fire('tool.execution_complete', {
				toolCallId: 'tc-r-1',
				success: true,
				result: { content: 'hi' },
			} as SessionEventPayload<'tool.execution_complete'>['data']);

			// Second round of reasoning, after the tool call. This must
			// land in a NEW reasoning response part — otherwise the
			// renderer / state-tree would merge it into the pre-tool-call
			// block and the visual ordering would be wrong on restore.
			mockSession.fire('assistant.reasoning_delta', {
				deltaContent: 'thinking step 2',
			} as SessionEventPayload<'assistant.reasoning_delta'>['data']);

			// Pull the protocol-level reasoning response parts. Both
			// `SessionResponsePart{Reasoning}` (allocates a new part) and
			// `SessionReasoning` (appends to an existing part) translate to
			// the legacy `'reasoning'` view, so we have to inspect raw
			// signals to tell them apart.
			const reasoningResponseParts = signals.flatMap(s => {
				if (s.kind !== 'action' || s.action.type !== ActionType.SessionResponsePart) {
					return [];
				}
				return s.action.part.kind === ResponsePartKind.Reasoning ? [s.action.part] : [];
			});
			assert.strictEqual(reasoningResponseParts.length, 2,
				'reasoning after a tool call should allocate a new response part, not append to the part from before the tool call');
			assert.notStrictEqual(reasoningResponseParts[0].id, reasoningResponseParts[1].id,
				'second reasoning round should have a distinct part id');
			assert.strictEqual(reasoningResponseParts[0].content, 'thinking step 1');
			assert.strictEqual(reasoningResponseParts[1].content, 'thinking step 2');
		});
	});

	// ---- user input handling ----

	suite('user input handling', () => {

		test('handleUserInputRequest fires user_input_request progress event', async () => {
			const { session, signals } = await createAgentSession(disposables);

			// Start the request (don't await — it blocks waiting for response)
			const resultPromise = session.handleUserInputRequest(
				{ question: 'What is your name?' },
				{ sessionId: 'test-session-1' }
			);

			// Verify signal was fired
			assert.strictEqual(signals.length, 1);
			const request = getInputRequest(signals[0]);
			const requestId = request.id;
			assert.ok(request.questions);
			assert.strictEqual(request.questions[0].message, 'What is your name?');
			const questionId = request.questions[0].id;

			// Respond to unblock the promise
			session.respondToUserInputRequest(requestId, SessionInputResponseKind.Accept, {
				[questionId]: {
					state: SessionInputAnswerState.Submitted,
					value: { kind: SessionInputAnswerValueKind.Text, value: 'Alice' }
				}
			});

			const result = await resultPromise;
			assert.strictEqual(result.answer, 'Alice');
			assert.strictEqual(result.wasFreeform, true);
		});

		test('handleUserInputRequest with choices generates SingleSelect question', async () => {
			const { session, signals } = await createAgentSession(disposables);

			const resultPromise = session.handleUserInputRequest(
				{ question: 'Pick a color', choices: ['red', 'blue', 'green'] },
				{ sessionId: 'test-session-1' }
			);

			assert.strictEqual(signals.length, 1);
			const request = getInputRequest(signals[0]);
			assert.ok(request.questions);
			assert.strictEqual(request.questions.length, 1);
			assert.strictEqual(request.questions[0].kind, SessionInputQuestionKind.SingleSelect);
			if (request.questions[0].kind === SessionInputQuestionKind.SingleSelect) {
				assert.strictEqual(request.questions[0].options.length, 3);
				assert.strictEqual(request.questions[0].options[0].label, 'red');
			}

			// Respond with a selected choice
			const questions = request.questions;
			session.respondToUserInputRequest(request.id, SessionInputResponseKind.Accept, {
				[questions[0].id]: {
					state: SessionInputAnswerState.Submitted,
					value: { kind: SessionInputAnswerValueKind.Selected, value: 'blue' }
				}
			});

			const result = await resultPromise;
			assert.strictEqual(result.answer, 'blue');
			assert.strictEqual(result.wasFreeform, false);
		});

		test('handleUserInputRequest returns empty answer on cancel', async () => {
			const { session, signals } = await createAgentSession(disposables);

			const resultPromise = session.handleUserInputRequest(
				{ question: 'Cancel me' },
				{ sessionId: 'test-session-1' }
			);

			const request = getInputRequest(signals[0]);
			session.respondToUserInputRequest(request.id, SessionInputResponseKind.Cancel);

			const result = await resultPromise;
			assert.strictEqual(result.answer, '');
			assert.strictEqual(result.wasFreeform, true);
		});

		test('respondToUserInputRequest returns false for unknown id', async () => {
			const { session } = await createAgentSession(disposables);
			assert.strictEqual(session.respondToUserInputRequest('unknown-id', SessionInputResponseKind.Accept), false);
		});

		test('handleUserInputRequest returns empty answer on skipped question', async () => {
			const { session, signals } = await createAgentSession(disposables);

			const resultPromise = session.handleUserInputRequest(
				{ question: 'Skip me' },
				{ sessionId: 'test-session-1' }
			);

			const request = getInputRequest(signals[0]);
			const questionId = request.questions![0].id;
			session.respondToUserInputRequest(request.id, SessionInputResponseKind.Accept, {
				[questionId]: {
					state: SessionInputAnswerState.Skipped,
				}
			});

			const result = await resultPromise;
			assert.strictEqual(result.answer, '');
			assert.strictEqual(result.wasFreeform, true);
		});

		test('pending user inputs are cancelled on dispose', async () => {
			const { session } = await createAgentSession(disposables);

			const resultPromise = session.handleUserInputRequest(
				{ question: 'Will be cancelled' },
				{ sessionId: 'test-session-1' }
			);

			session.dispose();
			const result = await resultPromise;
			assert.strictEqual(result.answer, '');
			assert.strictEqual(result.wasFreeform, true);
		});
	});

	suite('SDK callback logging', () => {

		test('logs and rethrows user input callback failures', async () => {
			const logService = new CapturingLogService();
			const { session } = await createAgentSession(disposables, { logService });
			const sessionInternals = session as unknown as ISessionInternalsForTest;
			sessionInternals._onDidSessionProgress.fire = () => {
				throw new Error('user input boom');
			};

			await assert.rejects(
				session.handleUserInputRequest(
					{ question: 'Need input' },
					{ sessionId: 'test-session-1' },
				),
				/user input boom/,
			);

			assert.strictEqual(logService.errors.length, 1);
			const [entry] = logService.errors;
			assert.ok(entry.first instanceof Error);
			assert.strictEqual((entry.first as Error).message, 'user input boom');
			assert.strictEqual(entry.args[0], '[Copilot:test-session-1] Failed to handle user input request: question="Need input"');
		});

		test('logs and rethrows onPreToolUse failures', async () => {
			const logService = new CapturingLogService();
			const capturedCallbacks: { current?: Parameters<SessionWrapperFactory>[0] } = {};
			const { session } = await createAgentSession(disposables, { logService, captureWrapperCallbacks: capturedCallbacks });
			const sessionInternals = session as unknown as ISessionInternalsForTest;
			sessionInternals._editTracker.trackEditStart = async () => {
				throw new Error('pre tool boom');
			};

			await assert.rejects(
				capturedCallbacks.current!.hooks.onPreToolUse({
					timestamp: 0,
					cwd: '/tmp',
					toolName: 'edit',
					toolArgs: { path: '/tmp/file.ts' },
				}),
				/pre tool boom/,
			);

			assert.strictEqual(logService.errors.length, 1);
			const [entry] = logService.errors;
			assert.ok(entry.first instanceof Error);
			assert.strictEqual((entry.first as Error).message, 'pre tool boom');
			assert.strictEqual(entry.args[0], '[Copilot:test-session-1] Failed in onPreToolUse: tool=edit');
		});

		test('logs and rethrows onPostToolUse failures', async () => {
			const logService = new CapturingLogService();
			const capturedCallbacks: { current?: Parameters<SessionWrapperFactory>[0] } = {};
			const { session } = await createAgentSession(disposables, { logService, captureWrapperCallbacks: capturedCallbacks });
			const sessionInternals = session as unknown as ISessionInternalsForTest;
			sessionInternals._editTracker.completeEdit = async () => {
				throw new Error('post tool boom');
			};

			await assert.rejects(
				capturedCallbacks.current!.hooks.onPostToolUse({
					timestamp: 0,
					cwd: '/tmp',
					toolName: 'edit',
					toolArgs: { path: '/tmp/file.ts' },
					toolResult: { textResultForLlm: '', resultType: 'success' },
				}),
				/post tool boom/,
			);

			assert.strictEqual(logService.errors.length, 1);
			const [entry] = logService.errors;
			assert.ok(entry.first instanceof Error);
			assert.strictEqual((entry.first as Error).message, 'post tool boom');
			assert.strictEqual(entry.args[0], '[Copilot:test-session-1] Failed in onPostToolUse: tool=edit');
		});
	});

	// ---- client tool calls ----

	suite('client tool calls', () => {

		const snapshot: IActiveClientSnapshot = {
			clientId: 'test-client',
			tools: [{
				name: 'my_tool',
				description: 'A test tool',
				inputSchema: { type: 'object', properties: {} },
			}],
			plugins: [],
		};

		test('client tool handler waits for completion without emitting tool_ready', async () => {
			const { session, mockSession, signals } = await createAgentSession(disposables, { clientSnapshot: snapshot });

			// SDK emits tool.execution_start — tool_start fires immediately
			mockSession.fire('tool.execution_start', {
				toolCallId: 'tc-client-1',
				toolName: 'my_tool',
				arguments: {},
			} as SessionEventPayload<'tool.execution_start'>['data']);

			// tool_start fires immediately (client tools don't auto-ready)
			assert.strictEqual(signals.filter(s => isAction(s, ActionType.SessionToolCallStart)).length, 1);
			const startSignal = signals.find(s => isAction(s, ActionType.SessionToolCallStart));
			assert.ok(startSignal && isAction(startSignal, ActionType.SessionToolCallStart));
			if (isAction(startSignal!, ActionType.SessionToolCallStart)) {
				assert.strictEqual((startSignal.action as SessionToolCallStartAction).toolClientId, 'test-client');
			}

			// SDK invokes the handler — it creates a deferred and waits,
			// but does NOT fire tool_ready (that comes from the permission flow).
			const tools = session.createClientSdkTools();
			const handlerPromise = invokeClientToolHandler(tools[0], 'tc-client-1', { file: 'test.ts' });

			// No pending_confirmation or tool_ready should have been emitted by the handler
			assert.strictEqual(signals.filter(s => s.kind === 'pending_confirmation' || isAction(s, ActionType.SessionToolCallReady)).length, 0);

			// Complete the tool call
			session.handleClientToolCallComplete('tc-client-1', {
				success: true,
				pastTenseMessage: 'did it',
				content: [{ type: ToolResultContentType.Text, text: 'result text' }],
			});

			const result = await handlerPromise;
			assert.strictEqual(result.resultType, 'success');
			assert.strictEqual(result.textResultForLlm, 'result text');
		});

		test('client tool handler does not emit tool_ready (permission flow owns it)', async () => {
			const { session, mockSession, signals, waitForSignal } = await createAgentSession(disposables, { clientSnapshot: snapshot });

			// SDK emits tool.execution_start — tool_start fires immediately
			mockSession.fire('tool.execution_start', {
				toolCallId: 'tc-client-perm',
				toolName: 'my_tool',
				arguments: {},
			} as SessionEventPayload<'tool.execution_start'>['data']);

			// tool_start fired, no pending_confirmation yet
			assert.strictEqual(signals.filter(s => isAction(s, ActionType.SessionToolCallStart)).length, 1);
			assert.strictEqual(signals.filter(s => s.kind === 'pending_confirmation').length, 0);

			// Permission request fires — pending_confirmation from permission flow.
			const resultPromise = session.handlePermissionRequest({
				kind: 'custom-tool',
				toolCallId: 'tc-client-perm',
				toolName: 'my_tool',
			});

			// pending_confirmation from permission flow should have fired (with confirmationTitle)
			await waitForSignal(s => s.kind === 'pending_confirmation');
			const permSignals = signals.filter((s): s is IAgentToolPendingConfirmationSignal => s.kind === 'pending_confirmation');
			assert.strictEqual(permSignals.length, 1);
			assert.strictEqual(permSignals[0].state.toolCallId, 'tc-client-perm');
			assert.ok(permSignals[0].state.confirmationTitle);

			const tools = session.createClientSdkTools();
			const handlerPromise = invokeClientToolHandler(tools[0], 'tc-client-perm');

			// The handler should NOT emit its own pending_confirmation — only the
			// permission flow fires pending_confirmation for client tools.
			assert.strictEqual(signals.filter(s => s.kind === 'pending_confirmation').length, 1, 'handler should not emit a second pending_confirmation');

			// Approve and clean up
			session.respondToPermissionRequest('tc-client-perm', true);
			const permResult = await resultPromise;
			assert.strictEqual(permResult.kind, 'approved');
			session.handleClientToolCallComplete('tc-client-perm', {
				success: true,
				pastTenseMessage: 'did it',
			});
			await handlerPromise;
		});

		test('handleClientToolCallComplete pre-completes when no handler is waiting yet', async () => {
			const { session } = await createAgentSession(disposables, { clientSnapshot: snapshot });

			// Completion arrives before handler — pre-creates deferred
			session.handleClientToolCallComplete('tc-unknown', {
				success: true,
				pastTenseMessage: 'done',
			});

			// Handler picks up the pre-completed result
			const tools = session.createClientSdkTools();
			const result = await invokeClientToolHandler(tools[0], 'tc-unknown');
			assert.strictEqual(result.resultType, 'success');
		});

		test('handleClientToolCallComplete with failure result', async () => {
			const { session } = await createAgentSession(disposables, { clientSnapshot: snapshot });

			const tools = session.createClientSdkTools();
			const handlerPromise = invokeClientToolHandler(tools[0], 'tc-client-3');

			session.handleClientToolCallComplete('tc-client-3', {
				success: false,
				pastTenseMessage: 'failed',
				error: { message: 'something broke' },
			});

			const result = await handlerPromise;
			assert.strictEqual(result.resultType, 'failure');
			assert.strictEqual(result.error, 'something broke');
		});

		test('pending client tool calls are cancelled on dispose', async () => {
			const { session } = await createAgentSession(disposables, { clientSnapshot: snapshot });

			const tools = session.createClientSdkTools();
			const handlerPromise = invokeClientToolHandler(tools[0], 'tc-client-4');

			session.dispose();
			const result = await handlerPromise;
			assert.strictEqual(result.resultType, 'failure');
			assert.ok(result.error);
		});

		test('multiple concurrent client tool calls resolve independently', async () => {
			const { session } = await createAgentSession(disposables, { clientSnapshot: snapshot });

			const tools = session.createClientSdkTools();
			const promise1 = invokeClientToolHandler(tools[0], 'tc-multi-1');
			const promise2 = invokeClientToolHandler(tools[0], 'tc-multi-2');

			// Complete in reverse order
			session.handleClientToolCallComplete('tc-multi-2', {
				success: true,
				pastTenseMessage: 'second done',
				content: [{ type: ToolResultContentType.Text, text: 'result-2' }],
			});
			session.handleClientToolCallComplete('tc-multi-1', {
				success: true,
				pastTenseMessage: 'first done',
				content: [{ type: ToolResultContentType.Text, text: 'result-1' }],
			});

			const [result1, result2] = await Promise.all([promise1, promise2]);
			assert.strictEqual(result1.textResultForLlm, 'result-1');
			assert.strictEqual(result2.textResultForLlm, 'result-2');
		});

		test('handler cleans up deferred after consuming result', async () => {
			const { session } = await createAgentSession(disposables, { clientSnapshot: snapshot });

			const tools = session.createClientSdkTools();
			const handlerPromise = invokeClientToolHandler(tools[0], 'tc-cleanup');

			session.handleClientToolCallComplete('tc-cleanup', {
				success: true,
				pastTenseMessage: 'done',
				content: [{ type: ToolResultContentType.Text, text: 'ok' }],
			});

			await handlerPromise;

			// A second complete for the same toolCallId should create a new
			// deferred (not fail). This tests the cleanup path.
			session.handleClientToolCallComplete('tc-cleanup', {
				success: true,
				pastTenseMessage: 'done again',
			});
		});

		test('client tool handler logs and rethrows failures', async () => {
			const logService = new CapturingLogService();
			const { session } = await createAgentSession(disposables, { clientSnapshot: snapshot, logService });
			const tools = session.createClientSdkTools();
			const sessionInternals = session as unknown as ISessionInternalsForTest;
			sessionInternals._pendingClientToolCalls.get = () => {
				throw new Error('client tool boom');
			};

			await assert.rejects(
				invokeClientToolHandler(tools[0], 'tc-client-error'),
				/client tool boom/,
			);

			assert.strictEqual(logService.errors.length, 1);
			const [entry] = logService.errors;
			assert.ok(entry.first instanceof Error);
			assert.strictEqual((entry.first as Error).message, 'client tool boom');
			assert.strictEqual(entry.args[0], '[Copilot:test-session-1] Failed in client tool handler: tool=my_tool, toolCallId=tc-client-error');
		});

		test('permission request before client tool handler emits only confirmation ready', async () => {
			const { session, mockSession, signals, waitForSignal } = await createAgentSession(disposables, { clientSnapshot: snapshot });

			mockSession.fire('tool.execution_start', {
				toolCallId: 'tc-ready-data',
				toolName: 'my_tool',
				arguments: { file: 'test.ts' },
			} as SessionEventPayload<'tool.execution_start'>['data']);

			// tool_start should have fired
			assert.strictEqual(signals.filter(s => isAction(s, ActionType.SessionToolCallStart)).length, 1);

			// Permission before the handler should produce only the confirmation
			// pending_confirmation, not a synthetic auto-ready.
			const resultPromise = session.handlePermissionRequest({
				kind: 'custom-tool',
				toolCallId: 'tc-ready-data',
				toolName: 'my_tool',
			});

			await waitForSignal(s => s.kind === 'pending_confirmation');
			const permSignals = signals.filter((s): s is IAgentToolPendingConfirmationSignal => s.kind === 'pending_confirmation');
			assert.strictEqual(permSignals.length, 1);
			assert.ok(permSignals[0].state.confirmationTitle);

			session.respondToPermissionRequest('tc-ready-data', true);
			await resultPromise;
		});

		test('handleClientToolCallComplete with content containing embedded resources', async () => {
			const { session } = await createAgentSession(disposables, { clientSnapshot: snapshot });

			const tools = session.createClientSdkTools();
			const handlerPromise = invokeClientToolHandler(tools[0], 'tc-embedded');

			session.handleClientToolCallComplete('tc-embedded', {
				success: true,
				pastTenseMessage: 'done',
				content: [
					{ type: ToolResultContentType.Text, text: 'text part' },
					{ type: ToolResultContentType.EmbeddedResource, data: 'base64data', contentType: 'image/png' },
				],
			});

			const result = await handlerPromise;
			assert.strictEqual(result.resultType, 'success');
			// Text content should be extracted
			assert.strictEqual(result.textResultForLlm, 'text part');
		});
	});
});
