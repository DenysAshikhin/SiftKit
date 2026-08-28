import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeRepoSearchTaskKind,
  REPO_SEARCH_TASK_KINDS,
  RepoSearchTaskKindSchema,
} from '../src/repo-search/task-kind.js';
import { RepoSearchRuntimeProfile } from '../src/repo-search/engine/runtime-profile.js';
import type { RunToolArgs } from '../src/repo-search/repo-tool-arguments.js';
import { RUN_FULL_DOWNGRADE_NOTICE } from '../src/repo-search/engine/validation-command-output-policy.js';

test('task-kind schema and normalizer preserve every exact execution kind', () => {
  for (const kind of REPO_SEARCH_TASK_KINDS) {
    assert.equal(RepoSearchTaskKindSchema.parse(kind), kind);
    assert.equal(normalizeRepoSearchTaskKind(kind), kind);
  }
  assert.equal(normalizeRepoSearchTaskKind(undefined), 'repo-search');
  assert.equal(RepoSearchTaskKindSchema.safeParse('summary').success, false);
});

test('runtime profile owns turn limits and loop kinds for every task kind', () => {
  const expectations = [
    { kind: 'plan', maxTurns: 45, loopKind: 'repo-search' },
    { kind: 'repo-search', maxTurns: 45, loopKind: 'repo-search' },
    { kind: 'chat', maxTurns: 45, loopKind: 'chat' },
    { kind: 'repo-agent', maxTurns: 100, loopKind: 'repo-agent' },
  ] as const;

  for (const expectation of expectations) {
    const profile = new RepoSearchRuntimeProfile(expectation.kind);
    assert.equal(profile.resolveMaxTurns(undefined, 45), expectation.maxTurns);
    assert.equal(profile.resolveMaxTurns(125, 45), 125);
    assert.equal(profile.loopKind, expectation.loopKind);
  }
});

test('runtime profile owns validation shaping and the full-output retry lifecycle', () => {
  const output = Array.from(
    { length: 60 },
    (_, index) => `validation-line-${index + 1}`,
  ).join('\n');
  const agent = new RepoSearchRuntimeProfile('repo-agent');
  const standard = new RepoSearchRuntimeProfile('repo-search');
  const automaticCall = { command: 'npm test' } satisfies RunToolArgs;
  const fullCall = { command: 'npm test', outputMode: 'full' } satisfies RunToolArgs;

  const automatic = agent.applyRunOutput({
    call: automaticCall,
    output,
    decision: agent.beginRun(automaticCall),
  });
  assert.match(automatic, /^10 lines omitted/u);
  assert.doesNotMatch(automatic, /validation-line-1\b/u);
  assert.match(automatic, /validation-line-60\b/u);

  const downgradedDecision = agent.beginRun(fullCall);
  assert.deepEqual(downgradedDecision, {
    kind: 'downgrade',
    effectiveMode: 'auto',
    downgraded: true,
  });
  const downgraded = agent.applyRunOutput({
    call: fullCall,
    output,
    decision: downgradedDecision,
  });
  assert.match(downgraded, /^10 lines omitted/u);
  assert.match(downgraded, new RegExp(RUN_FULL_DOWNGRADE_NOTICE, 'u'));

  const retryDecision = agent.beginRun(fullCall);
  assert.deepEqual(retryDecision, {
    kind: 'retry',
    effectiveMode: 'full',
    downgraded: false,
  });
  assert.equal(agent.applyRunOutput({
    call: fullCall,
    output,
    decision: retryDecision,
  }), output);

  assert.deepEqual(agent.beginRun(fullCall), { kind: 'duplicate' });

  const nonValidationCall = { command: 'rg test src' } satisfies RunToolArgs;
  assert.equal(agent.applyRunOutput({
    call: nonValidationCall,
    output,
    decision: agent.beginRun(nonValidationCall),
  }), output);
  assert.equal(standard.applyRunOutput({
    call: automaticCall,
    output,
    decision: standard.beginRun(automaticCall),
  }), output);
});
