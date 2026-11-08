import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APPROVAL_REVIEW_REQUEST_MARKER,
  APPROVER_SYSTEM_PROMPT,
  buildApprovalReviewRequest,
} from '../src/repo-search/approval-review-policy.ts';
import { buildApprovalReviewPayload } from '../src/repo-search/engine/approval-gate.ts';

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
      args: toolName === 'git' ? { operation: 'status' } : { command: 'git status --short' },
    }), null);
  });
}

test('an edit review request carries its payload after the command', () => {
  const reviewPayload = buildApprovalReviewPayload({ toolName: 'write', args: { path: 'a.ts', content: 'x' } });
  assert.equal(buildApprovalReviewRequest({ toolName: 'write', command: 'write path="a.ts"', reviewPayload }), [
    APPROVAL_REVIEW_REQUEST_MARKER,
    'tool: write',
    'command: write path="a.ts"',
    'payload:',
    reviewPayload,
  ].join('\n'));
});

test('the approver prompt names its role, forbids tool calls, and allows only the verdict schema', () => {
  assert.match(APPROVER_SYSTEM_PROMPT, /You are not that agent/u);
  assert.match(APPROVER_SYSTEM_PROMPT, /block of the user message/u);
  assert.match(APPROVER_SYSTEM_PROMPT, /Do not call tools/u);
  assert.match(
    APPROVER_SYSTEM_PROMPT,
    /return only JSON:\n\{"verdict":"approve"\|"deny"\|"unsure","reason":"<one sentence>"\}/u,
  );
});
