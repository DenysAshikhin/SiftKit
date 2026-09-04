import assert from 'node:assert/strict';
import test from 'node:test';

import { buildToolActivityRing, getToolActivityLabel } from '../src/lib/tool-activity-ring';
import type { ChatToolCallMessage } from '../src/types';

function tool(options: {
  id: string;
  turn: number;
  activityKind: ChatToolCallMessage['toolCallActivityKind'];
  subject: ChatToolCallMessage['toolCallActivitySubject'];
  status?: ChatToolCallMessage['toolCallStatus'];
  exitCode?: number | null;
}): ChatToolCallMessage {
  return {
    id: options.id,
    role: 'assistant',
    kind: 'assistant_tool_call',
    content: 'hidden command',
    inputTokensEstimate: 0,
    outputTokensEstimate: 0,
    thinkingTokens: 0,
    createdAtUtc: '2026-08-27T00:00:00.000Z',
    sourceRunId: null,
    toolCallCommand: 'hidden command',
    toolCallActivityKind: options.activityKind,
    toolCallActivitySubject: options.subject,
    toolCallTurn: options.turn,
    toolCallMaxTurns: 45,
    toolCallExitCode: options.exitCode ?? null,
    toolCallStatus: options.status ?? (options.exitCode === undefined ? 'running' : 'done'),
  };
}

test('groups same-turn activity and names one or multiple file subjects', () => {
  const groups = buildToolActivityRing([
    tool({ id: 'a', turn: 2, activityKind: 'read', subject: { kind: 'file', value: 'ChatTab.tsx' }, exitCode: 0 }),
    tool({ id: 'b', turn: 2, activityKind: 'read', subject: { kind: 'file', value: 'chatTurns.ts' } }),
    tool({ id: 'c', turn: 2, activityKind: 'edit', subject: { kind: 'file', value: 'ChatTab.tsx' } }),
  ]);

  assert.equal(groups.length, 2);
  assert.equal(getToolActivityLabel(groups[0]), 'Reading multiple files…');
  assert.equal(getToolActivityLabel(groups[1]), 'Editing file ChatTab.tsx…');
});

test('keeps only the newest three groups and renders terminal state copy', () => {
  const groups = buildToolActivityRing([
    tool({ id: 'a', turn: 1, activityKind: 'search', subject: { kind: 'none' }, exitCode: 0 }),
    tool({ id: 'b', turn: 2, activityKind: 'validate', subject: { kind: 'none' }, exitCode: 0 }),
    tool({ id: 'c', turn: 3, activityKind: 'web_fetch', subject: { kind: 'host', value: 'example.com' }, exitCode: 1 }),
    tool({ id: 'd', turn: 4, activityKind: 'command', subject: { kind: 'none' } }),
  ]);

  assert.deepEqual(groups.map((group) => group.turn), [2, 3, 4]);
  assert.equal(getToolActivityLabel(groups[0]), 'Validated project');
  assert.equal(getToolActivityLabel(groups[1]), 'Loading example.com — failed');
  assert.equal(getToolActivityLabel(groups[2]), 'Running command…');
});

test('stopped groups are terminal and distinct from active groups', () => {
  const group = buildToolActivityRing([
    tool({
      id: 'a',
      turn: 1,
      activityKind: 'read',
      subject: { kind: 'file', value: 'src/a.ts' },
      status: 'stopped',
    }),
  ])[0];
  assert.equal(group?.state, 'stopped');
  if (group) assert.equal(getToolActivityLabel(group), 'Reading file src/a.ts — stopped');
});
