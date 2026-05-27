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

test('buildTaskSystemPrompt preserves load-bearing planner rules after compression', () => {
  withTempRepo((repoRoot) => {
    const prompt = buildTaskSystemPrompt(repoRoot);

    // Header / output contract
    assert.match(prompt, /You are a repo-search planner\./u);
    assert.match(prompt, /tool_batch/u);
    assert.match(prompt, /"action":"finish"/u);

    // Anchor-before-read
    assert.match(prompt, /3 of your first 5/u);
    assert.match(prompt, /5 keywords/u);
    assert.match(prompt, /500 lines/u);

    // Finish gate + minimum depth
    assert.match(prompt, /5 tool-call turns/u);
    assert.match(prompt, /shallow search/u);
    assert.match(prompt, /anchor/u);

    // Output style
    assert.match(prompt, /<=20-line window/u);

    // Command discipline
    assert.match(prompt, /read-only/u);
    assert.match(prompt, /PowerShell/u);
    assert.match(prompt, /tiny|small/u); // do-not-tiny-slice rule survives in some form
    assert.match(prompt, /duplicate/iu);

    // Auto-normalization notice (still relevant — engine appends --no-ignore)
    assert.match(prompt, /--no-ignore/u);
    assert.match(prompt, /--type tsx/u);

    // Unix bans
    assert.match(prompt, /head/u);
    assert.match(prompt, /xargs/u);
  });
});

test('buildTaskSystemPrompt compression keeps prompt under 6000 chars (no agents.md)', () => {
  withTempRepo((repoRoot) => {
    const prompt = buildTaskSystemPrompt(repoRoot, { includeAgentsMd: false });
    assert.ok(
      prompt.length <= 6000,
      `expected compressed prompt <= 6000 chars, got ${prompt.length}`,
    );
  });
});

test('buildTaskSystemPrompt turn-1 directive does not hardcode a "src" path', () => {
  withTempRepo((repoRoot) => {
    const prompt = buildTaskSystemPrompt(repoRoot);

    // The turn-1 rg recipe must not blind-guess a top-level "src" folder —
    // many repos use apps/runner/src, packages/*/src, etc. The model should
    // search from CWD with no path so the runtime ignore-policy filters noise.
    assert.doesNotMatch(prompt, /rg -n "k1\|k2\|k3\|k4\|k5" src/u);

    // Examples must not reinforce the same "src" bias.
    assert.doesNotMatch(prompt, /rg -n \\"invokePlannerMode\\" src/u);
    assert.doesNotMatch(prompt, /"path":"src","glob"/u);

    // The 5-keyword turn-1 rule itself must survive.
    assert.match(prompt, /Turn 1: pick 5 keywords/u);
    assert.match(prompt, /k1\|k2\|k3\|k4\|k5/u);
  });
});

test('buildTaskSystemPrompt illustrative examples do not bias toward "src/" path prefixes', () => {
  withTempRepo((repoRoot) => {
    const prompt = buildTaskSystemPrompt(repoRoot);

    // Anchor-format example, JSON example for repo_read_file, and finish-output
    // example all used to start with "src/" or "src\\". Strip that bias so repos
    // with apps/, packages/, or arbitrary layouts are not implicitly disfavored.
    assert.doesNotMatch(prompt, /src\/foo\.ts:45-60/u);
    assert.doesNotMatch(prompt, /"path":"src\\\\summary\.ts"/u);
    assert.doesNotMatch(prompt, /src\/config\.ts:42/u);
    assert.doesNotMatch(prompt, /src\/summary\.ts:120-135/u);

    // The illustrative shapes themselves must still be present (path:line range,
    // Windows-backslash JSON path, finish-output anchor-bullet format).
    assert.match(prompt, /\bdir\/foo\.ts:45-60\b/u);
    assert.match(prompt, /"path":"[^"]+\\\\[^"]+\.ts"/u);
    assert.match(prompt, /:42 — definition/u);
    assert.match(prompt, /:120-135 — call site/u);
  });
});
