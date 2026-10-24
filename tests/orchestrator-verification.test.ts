import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { findEvidenceProblem } from '../src/orchestrator/verification.ts';
import { renderOrchestratorPlan } from '../src/orchestrator/plan.ts';
import { makeOrchestratorPlan, makeOrchestratorTask } from './helpers/orchestrator-plan.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

const COMMAND = { kind: 'command', command: 'npm test', cwd: '.', expectedExitCode: 0 } as const;

function repo(): string {
  const root = createManagedTempDir('siftkit-verification-');
  fs.writeFileSync(path.join(root, 'README.md'), '# Title\nnpm install\n');
  return root;
}

test('cited code evidence holds only when its snippet sits at that line of a repository file', () => {
  const root = repo();
  const problem = (file: string, line: number, snippet: string) => findEvidenceProblem(root, { path: file, line, snippet });
  assert.equal(problem('README.md', 2, 'npm   install'), null, 'whitespace differences do not matter');
  assert.equal(problem('README.md', 40, 'npm install'), 'README.md:40 is past the end of the file');
  assert.equal(problem('docs/missing.md', 1, 'x'), 'docs/missing.md does not exist in the repository');
  assert.equal(problem('README.md', 2, 'yarn add'), 'README.md:2 does not contain the cited snippet');
  assert.equal(problem('../outside.md', 1, 'x'), '../outside.md does not exist in the repository');
});

test('a rendered plan states every task scope, step, check, and acceptance criterion', () => {
  const markdown = renderOrchestratorPlan(makeOrchestratorPlan([
    makeOrchestratorTask(),
    makeOrchestratorTask({ id: 'edit', title: 'Edit loader', workerPresetId: 'repo-agent', dependsOn: ['inspect'],
      writePaths: ['src/a.ts'], verification: [COMMAND] }),
  ]));
  for (const expected of ['# Exercise the orchestrator.', '## Task inspect: Inspect README', '- Worker: `repo-search`',
    '- Writes: none (read-only)', '## Task edit: Edit loader', '- Depends on: `inspect`', '- Writes: `src/a.ts`',
    '1. Read README.md and report its installation commands.', '   Expected: Commands with file and line evidence.',
    '- Run `npm test` in `.`; expected exit 0.', '- Every reported command is supported by the current README.',
    '## Final verification']) {
    assert.ok(markdown.includes(expected), expected);
  }
});
