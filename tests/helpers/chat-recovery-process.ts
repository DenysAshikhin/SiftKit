import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { mock } from 'node:test';
import { z } from '../../src/lib/zod.js';
import { toError } from '../../src/lib/errors.js';
import { terminateProcessTree } from '../../src/lib/process-tree.js';
import { ChatSessionOperationKindSchema, type ChatTranscriptEvent } from '@siftkit/contracts';
import { getRuntimeDatabase, getRuntimeDatabasePath } from '../../src/state/runtime-db.js';
import { ChatJournalStore } from '../../src/state/chat-journal.js';
import { readChatSessionFromDatabase, saveChatSession } from '../../src/state/chat-sessions.js';
import { getConfigPath, getRuntimeRoot } from '../../src/status-server/paths.js';
import { writeConfig } from '../../src/status-server/config-store.js';
import { startStatusServer } from '../../src/status-server/index.js';
import { ChatRunRecorder } from '../../src/status-server/chat-run-recorder.js';
import { ChatOperationSnapshotReader } from '../../src/status-server/chat-operation-snapshot.js';
import { getAddressInfo } from './dashboard-http.js';
import { getDefaultServerConfig, mockModelPreset } from './mock-config.js';
import { createTestChatSession } from './chat-sessions.js';

export const RECOVERY_CHILD_ENV = 'SIFTKIT_TEST_CHAT_RECOVERY_CHILD';
const CONTROL_PREFIX = 'CHAT_RECOVERY_CONTROL ';
export const ChatRecoveryBarrierSchema = z.enum(['none', 'submission', 'text', 'proposal', 'approval', 'start', 'effect', 'result', 'projection', 'terminal', 'queue']);
export const ChatRecoveryProcessConfigSchema = z.strictObject({
  root: z.string().min(1), providerUrl: z.string().url(), barrier: ChatRecoveryBarrierSchema,
  operationKind: ChatSessionOperationKindSchema, clockAdvanceMs: z.number().int().nonnegative(),
});
type ProcessConfig = z.infer<typeof ChatRecoveryProcessConfigSchema>;
const ControlMessageSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ready'), url: z.string().url() }),
  z.strictObject({ kind: z.literal('barrier'), barrier: ChatRecoveryBarrierSchema, operationId: z.string().uuid(), sequence: z.number().int().nonnegative() }),
]);
type ControlMessage = z.infer<typeof ControlMessageSchema>;

/** The synchronous pipe write precedes a permanent block, so no later application code can run. */
function publish(message: ControlMessage): void {
  writeSync(1, `${CONTROL_PREFIX}${JSON.stringify(ControlMessageSchema.parse(message))}\n`);
}

export async function runChatRecoveryProcess(config: ProcessConfig): Promise<void> {
  const actualNow = Date.now;
  if (config.clockAdvanceMs > 0) mock.method(Date, 'now', () => actualNow() + config.clockAdvanceMs);
  process.env.SIFTKIT_STATUS_HOST = '127.0.0.1';
  process.env.SIFTKIT_STATUS_PORT = '0';
  delete process.env.SIFTKIT_CONFIG_SERVICE_URL;
  delete process.env.SIFTKIT_STATUS_BACKEND_URL;
  process.env.SIFTKIT_CONFIG_PATH = join(config.root, '.siftkit', 'config.json');
  process.env.SIFTKIT_STATUS_PATH = join(config.root, '.siftkit', 'status', 'inference.txt');
  process.env.sift_kit_status = process.env.SIFTKIT_STATUS_PATH;
  const serverConfig = getDefaultServerConfig();
  const model = mockModelPreset({ id: 'crash-model', Model: 'mock', ExternalServerEnabled: true,
    BaseUrl: config.providerUrl, NumCtx: 8192, VisionEnabled: true, VisionImageRetention: 4,
    Reasoning: 'on', ReasoningContent: true, PreserveThinking: true, MaintainPerStepThinking: true });
  serverConfig.Server.ModelPresets.Presets = [model];
  serverConfig.Server.ModelPresets.ActivePresetId = model.id;
  writeConfig(getConfigPath(), serverConfig);
  const database = getRuntimeDatabase(getRuntimeDatabasePath());
  if (!readChatSessionFromDatabase(database, 'crash-session')) {
    const session = createTestChatSession(getRuntimeRoot());
    session.id = 'crash-session';
    session.modelPresetId = model.id;
    session.modelPreset = model;
    session.planRepoRoot = config.root;
    session.presetId = config.operationKind === 'message' || config.operationKind === 'condense' ? 'chat' : config.operationKind;
    session.mode = config.operationKind === 'plan' ? 'plan' : config.operationKind === 'repo-search' || config.operationKind === 'repo-agent' ? 'repo-search' : 'chat';
    session.messages = [
      { id: 'prior-user', role: 'user', kind: 'user_text', content: 'CRASH_PRIOR_17', createdAtUtc: session.createdAtUtc,
        inputTokensEstimate: 1, outputTokensEstimate: 0, thinkingTokens: 0 },
      { id: 'prior-answer', role: 'assistant', kind: 'assistant_answer', content: 'Prior answer', createdAtUtc: session.createdAtUtc,
        inputTokensEstimate: 0, outputTokensEstimate: 1, thinkingTokens: 0 },
    ];
    saveChatSession(getRuntimeRoot(), session);
  }

  let target: ChatRunRecorder | null = null;
  const freeze = (barrier: z.infer<typeof ChatRecoveryBarrierSchema>, recorder: ChatRunRecorder): void => {
    if (config.barrier !== barrier || target?.operationId !== recorder.operationId) return;
    const run = new ChatJournalStore(getRuntimeDatabase(getRuntimeDatabasePath())).readRun(recorder.operationId);
    if (!run) throw new Error('Crash barrier lost its committed run.');
    publish({ kind: 'barrier', barrier, operationId: recorder.operationId, sequence: run.latestSequence });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    throw new Error('A crash barrier must never resume.');
  };
  const begin = ChatRunRecorder.begin;
  mock.method(ChatRunRecorder, 'begin', (database: Parameters<typeof begin>[0], input: Parameters<typeof begin>[1]) => {
    const recorder = begin(database, input);
    if (input.operationKind === config.operationKind) target = recorder;
    freeze('submission', recorder);
    return recorder;
  });
  const proposed = ChatRunRecorder.prototype.recordToolProposed;
  mock.method(ChatRunRecorder.prototype, 'recordToolProposed', function(this: ChatRunRecorder, evidence: Parameters<typeof proposed>[0]) {
    proposed.call(this, evidence);
    freeze('proposal', this);
  });
  const approval = ChatRunRecorder.prototype.recordApprovalRequested;
  mock.method(ChatRunRecorder.prototype, 'recordApprovalRequested', function(this: ChatRunRecorder, evidence: Parameters<typeof approval>[0]) {
    approval.call(this, evidence);
    freeze('approval', this);
  });
  const started = ChatRunRecorder.prototype.recordToolStarted;
  mock.method(ChatRunRecorder.prototype, 'recordToolStarted', function(this: ChatRunRecorder, evidence: Parameters<typeof started>[0]) {
    started.call(this, evidence);
    freeze('start', this);
  });
  const result = ChatRunRecorder.prototype.recordToolResult;
  mock.method(ChatRunRecorder.prototype, 'recordToolResult', function(this: ChatRunRecorder, evidence: Parameters<typeof result>[0]) {
    freeze('effect', this);
    result.call(this, evidence);
    freeze('result', this);
  });
  const finish = ChatRunRecorder.prototype.finish;
  mock.method(ChatRunRecorder.prototype, 'finish', function(this: ChatRunRecorder, outcome: Parameters<typeof finish>[0]) {
    finish.call(this, outcome);
    freeze('terminal', this);
  });
  const claim = ChatRunRecorder.prototype.claimQueuedMessages;
  mock.method(ChatRunRecorder.prototype, 'claimQueuedMessages', function(this: ChatRunRecorder, sessionId: string, input: Parameters<typeof claim>[1], modelPreset: Parameters<typeof claim>[2], forceId?: string) {
    const messages = claim.call(this, sessionId, input, modelPreset, forceId);
    if (messages.length > 0) freeze('queue', this);
    return messages;
  });
  const display = ChatRunRecorder.prototype.recordDisplay;
  mock.method(ChatRunRecorder.prototype, 'recordDisplay', function(this: ChatRunRecorder, event: ChatTranscriptEvent) {
    display.call(this, event);
    if (target && (event.kind === 'narration' || event.kind === 'answer') && event.delta.text.includes('CRASH_PARTIAL_21')) freeze('text', target);
  });
  const capture = ChatOperationSnapshotReader.prototype.capture;
  mock.method(ChatOperationSnapshotReader.prototype, 'capture', function(this: ChatOperationSnapshotReader, database: Parameters<typeof capture>[0], live: Parameters<typeof capture>[1], nowMs?: number) {
    const captured = capture.call(this, database, live, nowMs);
    if (target && captured.snapshot.messages.some(message => message.content.includes('CRASH_PARTIAL_21'))) freeze('projection', target);
    return captured;
  });
  process.on('exit', () => { appendFileSync(join(config.root, 'clean-shutdown.txt'), 'cleanup\n'); });
  const server = startStatusServer({ disableManagedEngineStartup: true, terminalMetadataIdleDelayMs: 0 });
  await server.startupPromise;
  const url = `http://127.0.0.1:${getAddressInfo(server).port}`;
  process.env.SIFTKIT_CONFIG_SERVICE_URL = `${url}/config`;
  process.env.SIFTKIT_STATUS_BACKEND_URL = `${url}/status`;
  publish({ kind: 'ready', url });
}

/** Owns exactly one spawned child; only that child's process tree may be terminated. */
export class ChatRecoveryProcess {
  private readonly child: ChildProcess;
  private readonly messages: ControlMessage[] = [];
  private waiting: { kind: ControlMessage['kind']; resolve(message: ControlMessage): void; reject(error: Error): void } | null = null;
  private readonly exited: Promise<void>;
  private failure: Error | null = null;
  private output = '';
  private tail = '';

  constructor(entrypoint: string, config: ProcessConfig) {
    this.child = spawn(process.execPath, [entrypoint], { cwd: config.root, windowsHide: true,
      env: { ...process.env, [RECOVERY_CHILD_ENV]: JSON.stringify(ChatRecoveryProcessConfigSchema.parse(config)) },
      stdio: ['ignore', 'pipe', 'pipe'] });
    this.exited = new Promise(resolve => this.child.once('exit', () => {
      this.fail(new Error(`Recovery child exited: ${this.tail}`));
      resolve();
    }));
    this.child.on('error', error => this.fail(error));
    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => {
      this.output += chunk;
      for (;;) {
        const newline = this.output.indexOf('\n');
        if (newline < 0) break;
        const line = this.output.slice(0, newline).trim();
        this.output = this.output.slice(newline + 1);
        if (!line.startsWith(CONTROL_PREFIX)) { this.tail = `${this.tail}\n${line}`.slice(-4000); continue; }
        try {
          const message = ControlMessageSchema.parse(JSON.parse(line.slice(CONTROL_PREFIX.length)));
          if (this.waiting?.kind === message.kind) { const waiting = this.waiting; this.waiting = null; waiting.resolve(message); }
          else this.messages.push(message);
        } catch (error) { this.fail(toError(error)); }
      }
    });
    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (chunk: string) => { this.tail = `${this.tail}\n${chunk}`.slice(-4000); });
  }

  async ready(): Promise<string> {
    const message = await this.waitFor('ready');
    if (message.kind !== 'ready') throw new Error('Expected child readiness.');
    return message.url;
  }
  async barrier() {
    const message = await this.waitFor('barrier');
    if (message.kind !== 'barrier') throw new Error('Expected child crash barrier.');
    return message;
  }
  async kill(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const pid = this.child.pid;
    if (pid === undefined) throw new Error('Test child has no process identity.');
    terminateProcessTree(pid);
    await this.exited;
  }
  private fail(error: Error): void { this.failure = error; this.waiting?.reject(error); this.waiting = null; }
  private waitFor(kind: ControlMessage['kind']): Promise<ControlMessage> {
    const index = this.messages.findIndex(message => message.kind === kind);
    if (index >= 0) {
      const message = this.messages.splice(index, 1)[0];
      if (!message) throw new Error('Child message disappeared.');
      return Promise.resolve(message);
    }
    if (this.failure) return Promise.reject(this.failure);
    if (this.waiting) throw new Error('Only one child message waiter is supported.');
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => this.fail(new Error(`Timed out awaiting ${kind}: ${this.tail}`)), 20_000);
      this.waiting = { kind, resolve(message) { clearTimeout(timeout); resolve(message); }, reject(error) { clearTimeout(timeout); reject(error); } };
    });
  }
}
