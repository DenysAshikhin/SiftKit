import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendToolBatchExchange,
  buildAssistantToolCallMessage,
  type ToolTranscriptMessage,
} from '../src/tool-call-messages.js';
import { RED_TEAM_CORPUS, RedTeamCaseSchema } from '../scripts/approval-red-team/corpus.js';
import { buildRedTeamReplay } from '../scripts/approval-red-team/replay.js';
import { comparePlacements, scoreRun } from '../scripts/approval-red-team/score.js';

test('the shared assistant builder matches the batch transcript message', () => {
  const outcomes = [{
    action: { toolName: 'write', args: { path: 'a.ts', content: 'x' } },
    toolCallId: 't1_c0',
    toolContent: 'ok',
  }];
  const messages: ToolTranscriptMessage[] = [];

  appendToolBatchExchange(messages, outcomes, 'thinking');

  assert.deepEqual(messages[0], buildAssistantToolCallMessage(outcomes, 'thinking'));
});

test('every corpus case parses and has a unique id', () => {
  const ids = new Set<string>();
  for (const entry of RED_TEAM_CORPUS) {
    RedTeamCaseSchema.parse(entry);
    assert.equal(ids.has(entry.id), false, `duplicate id ${entry.id}`);
    ids.add(entry.id);
  }
  assert.ok(RED_TEAM_CORPUS.some((entry) => entry.expect === 'allow'));
});

test('the shipped replay puts the payload in a pending assistant tool call', () => {
  const entry = RED_TEAM_CORPUS.find((candidate) => candidate.id === 'buried-base64-dropper');
  assert.ok(entry);
  const replay = buildRedTeamReplay(entry);
  const pending = replay.action.pendingMessages[0];

  assert.equal(pending?.role, 'assistant');
  assert.equal(pending?.tool_calls?.length, 1);
  assert.ok(JSON.stringify(pending?.tool_calls?.[0]?.function.arguments).includes('execSync'));
  assert.equal(replay.action.reviewPayload, null);
});

test('scoreRun counts must-deny approvals and benign denials', () => {
  const scored = scoreRun([
    { caseId: 'a', expect: 'deny', verdicts: ['deny', 'deny', 'unsure'] },
    { caseId: 'b', expect: 'deny', verdicts: ['approve', 'deny', 'deny'] },
    { caseId: 'c', expect: 'allow', verdicts: ['approve', 'approve', 'deny'] },
  ]);

  assert.deepEqual(scored.missedCaseIds, ['b']);
  assert.deepEqual(scored.falsePositiveCaseIds, ['c']);
  assert.equal(scored.escalatedCaseIds.length, 0);
});

test('comparePlacements flags candidate regressions', () => {
  const baseline = scoreRun([{ caseId: 'a', expect: 'deny', verdicts: ['deny'] }]);
  const candidate = scoreRun([{ caseId: 'a', expect: 'deny', verdicts: ['approve'] }]);

  assert.deepEqual(comparePlacements(baseline, candidate), {
    newMisses: ['a'],
    fixedMisses: [],
    falsePositiveDelta: 0,
    passed: false,
  });
});
