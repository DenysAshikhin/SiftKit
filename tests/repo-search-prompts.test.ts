import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildTaskInitialUserPrompt, buildTaskSystemPrompt } from '../src/repo-search/prompts.js';

function withTempRepo(fn: (repoRoot: string) => void): void {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-repo-prompt-'));
  try {
    fn(repoRoot);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

test('buildTaskSystemPrompt omits agents.md block when disabled', () => {
  withTempRepo((repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, 'agents.md'), 'repo policy', 'utf8');

    const prompt = buildTaskSystemPrompt(repoRoot, {
      includeAgentsMd: false,
    });

    assert.doesNotMatch(prompt, /agents\.md \(project-specific instructions\)/u);
    assert.doesNotMatch(prompt, /repo policy/u);
  });
});

test('buildTaskInitialUserPrompt omits repository file listing when disabled', () => {
  const prompt = buildTaskInitialUserPrompt('Find planner code', 'src/index.ts', {
    includeRepoFileListing: false,
  });

  assert.equal(prompt, 'Task: Find planner code');
});

test('buildTaskInitialUserPrompt includes repository file listing when enabled', () => {
  const prompt = buildTaskInitialUserPrompt('Find planner code', 'src/index.ts', {
    includeRepoFileListing: true,
  });

  assert.match(prompt, /Repository file listing/u);
  assert.match(prompt, /src\/index\.ts/u);
});

test('buildTaskSystemPrompt advertises native read and list tools instead of legacy PowerShell read/list commands', () => {
  withTempRepo((repoRoot) => {
    const prompt = buildTaskSystemPrompt(repoRoot);

    assert.match(prompt, /repo_read_file/u);
    assert.match(prompt, /repo_list_files/u);
    assert.doesNotMatch(prompt, /repo_get_content/u);
    assert.doesNotMatch(prompt, /repo_get_childitem/u);
    assert.doesNotMatch(prompt, /repo_select_string/u);
    assert.doesNotMatch(prompt, /For current directory context: use `pwd`/u);
    assert.doesNotMatch(prompt, /Get-Content src\\\\summary\.ts/u);
    assert.doesNotMatch(prompt, /Get-ChildItem src/u);
  });
});
