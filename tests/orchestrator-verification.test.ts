import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { findCitationProblem, findEvidenceProblem } from '../src/orchestrator/verification.ts';
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
  assert.equal(problem('README.md', 2, 'yarn add'),
    'README.md:2 does not contain the cited snippet; line 2 is `npm install`. Cite one line exactly as read shows it');
  assert.equal(problem('../outside.md', 1, 'x'), '../outside.md does not exist in the repository');
});

test('evidence and citation checks count lines as read does', () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'wide.ts'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('const wide = 1;\n', 'utf16le')]));
  fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03, 0x04, 0x05, 0x06, 0x07]));
  assert.equal(findCitationProblem(root, { path: 'README.md', line: 2 }), null);
  assert.equal(findCitationProblem(root, { path: 'README.md', line: 3 }), 'README.md:3 is past the end of the file');
  assert.equal(findEvidenceProblem(root, { path: 'README.md', line: 3, snippet: 'npm install' }), 'README.md:3 is past the end of the file');
  assert.equal(findEvidenceProblem(root, { path: 'wide.ts', line: 1, snippet: 'const wide = 1;' }), null);
  assert.equal(findCitationProblem(root, { path: 'blob.bin', line: 1 }), 'blob.bin is not a text file the checks can read');
  assert.equal(findEvidenceProblem(root, { path: 'blob.bin', line: 1, snippet: 'x' }), 'blob.bin is not a text file the checks can read');
  fs.mkdirSync(path.join(root, 'docs'));
  assert.equal(findEvidenceProblem(root, { path: 'docs', line: 1, snippet: 'x' }), 'docs is not a file in the repository');
  assert.equal(findCitationProblem(root, { path: 'docs', line: 1 }), 'docs is not a file in the repository');
});

test('a rendered plan states every task scope, step, check, and acceptance criterion', () => {
  const markdown = renderOrchestratorPlan(makeOrchestratorPlan([
    makeOrchestratorTask(),
    makeOrchestratorTask({ id: 'edit', title: 'Edit loader', workerPresetId: 'repo-agent', dependsOn: ['inspect'],
      writePaths: ['src/a.ts'], verification: [COMMAND] }),
  ]));
  for (const expected of ['# Exercise the orchestrator.', '## Task inspect: Inspect README', '- Worker: `repo-agent`',
    '- Writes: `README.md`', '## Task edit: Edit loader', '- Depends on: `inspect`', '- Writes: `src/a.ts`',
    '1. Read README.md and report its installation commands.', '   Expected: Commands with file and line evidence.',
    '- Run `npm test` in `.`; expected exit 0.', '- Every reported command is supported by the current README.',
    '## Final verification']) {
    assert.ok(markdown.includes(expected), expected);
  }
});

