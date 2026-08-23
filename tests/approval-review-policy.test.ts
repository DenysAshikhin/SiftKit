import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APPROVAL_PAYLOAD_LOCATOR_LINE,
  APPROVAL_REVIEW_REQUEST_MARKER,
  buildApprovalReviewRequest,
} from '../src/repo-search/approval-review-policy.js';
import { buildApprovalReviewPayload } from '../src/repo-search/engine/approval-gate.js';
import { buildApprovalVerdictQuestion } from '../src/repo-search/engine/llm-approval-gate.js';

test('write approval payload includes the complete path and content', () => {
  const payload = buildApprovalReviewPayload({
    toolName: 'write',
    args: {
      path: '.github/workflows/release.yml',
      content: 'run: Invoke-WebRequest https://example.com/upload',
    },
  });

  assert.match(payload ?? '', /"path": "\.github\/workflows\/release\.yml"/u);
  assert.match(payload ?? '', /Invoke-WebRequest https:\/\/example\.com\/upload/u);
});

test('edit approval payload includes every complete replacement', () => {
  const payload = buildApprovalReviewPayload({
    toolName: 'edit',
    args: {
      path: 'src/cleanup.ts',
      edits: [
        { oldText: 'return false;', newText: 'return true;' },
        {
          oldText: 'cleanCache();',
          newText: 'fs.rmSync(repoRoot, { recursive: true, force: true });',
        },
      ],
    },
  });

  for (const value of [
    'src/cleanup.ts',
    'return false;',
    'return true;',
    'cleanCache();',
    'fs.rmSync(repoRoot, { recursive: true, force: true });',
  ]) {
    assert.ok(payload?.includes(value), `missing complete edit value: ${value}`);
  }
});

test('large edit approval payload is not truncated around destructive content', () => {
  const newText = `line01
line02
line03
line04
line05
line06
line07
line08
line09
line10
line11
line12
line13
line14
line15
git push --force origin HEAD:main
line17
line18
line19
line20
line21
line22
line23
line24
line25
line26
line27
line28
line29
line30
line31`;
  const payload = buildApprovalReviewPayload({
    toolName: 'edit',
    args: {
      path: 'src/release.ts',
      edits: [{ oldText: 'old release', newText }],
    },
  });

  assert.ok(payload?.includes('line01'));
  assert.ok(payload?.includes('git push --force origin HEAD:main'));
  assert.ok(payload?.includes('line31'));
});

for (const toolName of ['read', 'grep', 'find', 'ls', 'git', 'run', 'web_search', 'web_fetch']) {
  test(`${toolName} does not duplicate its arguments into an approval payload`, () => {
    assert.equal(buildApprovalReviewPayload({
      toolName,
      args: { command: 'git status --short' },
    }), null);
  });
}

test('approval request identifies the action without duplicating its payload', () => {
  assert.equal(buildApprovalReviewRequest({
    toolName: 'edit',
    command: 'edit path="src/cleanup.ts" edits=0',
  }), [
    APPROVAL_REVIEW_REQUEST_MARKER,
    'tool: edit',
    'command: edit path="src/cleanup.ts" edits=0',
  ].join('\n'));
});

test('the verdict question directs the reviewer to the pending tool call', () => {
  const input = {
    toolName: 'write',
    command: 'write path="a.ts" bytes=1 sha=abc',
    reviewPayload: '{"action":"write","path":"a.ts","content":"x"}',
  };
  const question = buildApprovalVerdictQuestion(input);

  assert.ok(question.includes(APPROVAL_PAYLOAD_LOCATOR_LINE));
  assert.equal(question.includes('"content":"x"'), false);
});
