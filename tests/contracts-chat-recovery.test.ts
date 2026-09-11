import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHAT_APPROVAL_TIMEOUT_MS,
  CHAT_RECOVERY_ISSUE_DETAIL_MAX_CHARS,
  ChatOperationSnapshotSchema,
  ChatRecoveryIssueSchema,
  ChatRecoveryReportSchema,
  ChatRunEffectiveSettingsSchema,
  ChatToolExecutionStateSchema,
  DurableChatApprovalSchema,
  toolCallStatusForExecutionState,
} from '@siftkit/contracts';

const OPERATION_ID = '3e3b5cf7-39ce-438b-8d6c-1031056e471d';
const APPROVAL_ID = 'e08682f5-9b0d-49ab-b4ef-cc0f027089ff';
const RUN_ID = '706f2e52-01ec-4e62-9dc0-b7ced282e27e';

test('every execution state maps to exactly one display status', () => {
  assert.deepEqual(
    ChatToolExecutionStateSchema.options.map((state) => [state, toolCallStatusForExecutionState(state)]),
    [
      ['proposed', 'running'],
      ['pending_approval', 'running'],
      ['executing', 'running'],
      ['completed', 'done'],
      ['rejected', 'done'],
      ['not_started', 'stopped'],
      ['uncertain', 'stopped'],
    ],
  );
});

test('the approval deadline is ten minutes and is stored, not recomputed', () => {
  assert.equal(CHAT_APPROVAL_TIMEOUT_MS, 600_000);
  const requestedAtUtc = '2026-09-10T12:09:36.905Z';
  const approval = DurableChatApprovalSchema.parse({
    runId: RUN_ID,
    approvalId: APPROVAL_ID,
    toolCallId: 'call-1',
    toolName: 'run',
    command: 'Remove-Item research/brawl_sim/physics.py',
    reviewPayload: null,
    mode: 'interactive',
    requestedAtUtc,
    expiresAtUtc: new Date(Date.parse(requestedAtUtc) + CHAT_APPROVAL_TIMEOUT_MS).toISOString(),
    outcome: null,
    decidedAtUtc: null,
    actionable: true,
  });
  assert.equal(Date.parse(approval.expiresAtUtc) - Date.parse(approval.requestedAtUtc), 600_000);
});

test('a decided approval stays visible as history but is not actionable', () => {
  const approval = DurableChatApprovalSchema.parse({
    runId: RUN_ID,
    approvalId: APPROVAL_ID,
    toolCallId: 'call-1',
    toolName: 'run',
    command: 'Remove-Item research/brawl_sim/physics.py',
    reviewPayload: null,
    mode: 'interactive',
    requestedAtUtc: '2026-09-10T12:09:36.905Z',
    expiresAtUtc: '2026-09-10T12:19:36.905Z',
    outcome: 'timeout',
    decidedAtUtc: '2026-09-10T12:19:36.905Z',
    actionable: false,
  });
  assert.equal(approval.outcome, 'timeout');
  assert.equal(approval.actionable, false);
  assert.throws(() => DurableChatApprovalSchema.parse({ ...approval, outcome: 'expired' }));
});

test('a recovery issue carries identities and a bounded reason, never a payload', () => {
  const issue = ChatRecoveryIssueSchema.parse({
    code: 'malformed_event',
    operationId: OPERATION_ID,
    eventId: 'event-17',
    sequence: 17,
    detail: 'event body failed validation',
  });
  assert.equal(issue.code, 'malformed_event');
  assert.throws(() => ChatRecoveryIssueSchema.parse({
    ...issue,
    detail: 'x'.repeat(CHAT_RECOVERY_ISSUE_DETAIL_MAX_CHARS + 1),
  }));
  assert.throws(() => ChatRecoveryIssueSchema.parse({ ...issue, code: 'something_else' }));
  assert.throws(() => ChatRecoveryIssueSchema.parse({ ...issue, toolOutput: 'secret' }));
});

test('a no-change recovery report is representable and distinguishes status from terminal cause', () => {
  const report = ChatRecoveryReportSchema.parse({
    sessionId: 'session-1',
    operationId: OPERATION_ID,
    status: 'ok',
    terminalCause: 'approval_timeout',
    appliedSequence: 412,
    eventCount: 412,
    messageCount: 240,
    toolCount: 116,
    changed: false,
    issues: [],
  });
  assert.equal(report.changed, false);
  assert.equal(report.status, 'ok');
  assert.equal(report.terminalCause, 'approval_timeout');
  assert.throws(() => ChatRecoveryReportSchema.parse({ ...report, terminalCause: 'crashed' }));
});

test('effective settings record what a run executed under, including a null approval mode', () => {
  const settings = ChatRunEffectiveSettingsSchema.parse({
    operationKind: 'condense',
    mode: 'chat',
    presetId: 'chat',
    modelPresetId: 'preset-a',
    model: null,
    repoRoot: 'C:/repo',
    approval: null,
    maxTurns: null,
    thinkingEnabled: false,
    webSearchEnabled: true,
    contextWindowTokens: 32_768,
  });
  assert.equal(settings.approval, null);
  assert.throws(() => ChatRunEffectiveSettingsSchema.parse({ ...settings, maxTurns: 0 }));
  assert.throws(() => ChatRunEffectiveSettingsSchema.parse({ ...settings, operationKind: 'summarize' }));
});

test('an operation snapshot carries its cursor and derived tool states', () => {
  const snapshot = ChatOperationSnapshotSchema.parse({
    sessionId: 'session-1',
    operationId: OPERATION_ID,
    operationKind: 'repo-agent',
    recordKind: 'execution',
    startedAtUtc: '2026-09-10T11:04:54.755Z',
    terminalCause: 'approval_timeout',
    status: 'ok',
    cursor: { operationId: OPERATION_ID, sequence: 412 },
    runOrder: 1,
    controlOperationId: null,
    messages: [],
    tools: [{
      toolCallId: 'call-1',
      messageId: `stopped-${RUN_ID}-tool-call-1`,
      executionState: 'uncertain',
      toolCallStatus: toolCallStatusForExecutionState('uncertain'),
    }],
    approval: null,
    issues: [],
    tokenTurns: [],
    streamedCharsSinceBase: 0,
    warnings: [],
  });
  assert.equal(snapshot.cursor.sequence, 412);
  assert.equal(snapshot.tools[0]?.toolCallStatus, 'stopped');
  assert.throws(() => ChatOperationSnapshotSchema.parse({ ...snapshot, replayTruncated: false }));
});
