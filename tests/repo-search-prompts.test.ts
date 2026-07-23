import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildAgentSystemPrompt, buildTaskInitialUserPrompt, buildTaskSystemPrompt } from '../src/repo-search/prompts.js';
import { RUN_SHELL_LABEL, POWERSHELL_EXECUTABLE } from '../src/lib/powershell.js';

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

test('buildTaskInitialUserPrompt puts the stable file listing before the volatile task for prefix caching', () => {
  const prompt = buildTaskInitialUserPrompt('Find planner code', 'src/index.ts', {
    includeRepoFileListing: true,
  });

  assert.equal(prompt, [
    '--- Repository file listing (respects .gitignore) ---',
    '',
    'src/index.ts',
    '',
    'Task: Find planner code',
  ].join('\n'));
});

test('buildTaskSystemPrompt advertises the native tool surface and no shell commands', () => {
  withTempRepo((repoRoot) => {
    const prompt = buildTaskSystemPrompt(repoRoot);

    assert.match(prompt, /Tools: grep, find, ls, read, git/u);
    for (const toolName of ['grep', 'find', 'ls', 'read', 'git']) {
      assert.match(prompt, new RegExp(`\\{"action":"${toolName}"`, 'u'));
    }
    // `git` is the only tool that still takes a command string.
    assert.doesNotMatch(prompt, /Get-Content/u);
    assert.doesNotMatch(prompt, /Get-ChildItem/u);
    assert.doesNotMatch(prompt, /Select-String/u);
    assert.doesNotMatch(prompt, /\brg\b/u);
    assert.doesNotMatch(prompt, /repo_[a-z_]+/u);
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

    // Tool discipline
    assert.match(prompt, /read-only/u);
    assert.match(prompt, /tiny|small/u); // do-not-tiny-slice rule survives in some form
    assert.match(prompt, /duplicate/iu);

    // Native-arg contract: the non-git tools take structured fields, not shell strings
    assert.match(prompt, /Shell syntax in tool args/u);
    assert.match(prompt, /there is no `command` key on them/u);
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

    // The turn-1 grep recipe must not blind-guess a top-level "src" folder —
    // many repos use apps/runner/src, packages/*/src, etc. The model should
    // search from the repo root with no path so the ignore policy filters noise.
    assert.doesNotMatch(prompt, /"k1\|k2\|k3\|k4\|k5"[^\n]*\bsrc\b/u);

    // Examples must not reinforce the same "src" bias.
    assert.doesNotMatch(prompt, /"path":"src"/u);
    assert.doesNotMatch(prompt, /"path":"src\//u);

    // The 5-keyword turn-1 rule itself must survive.
    assert.match(prompt, /Turn 1: pick 5 keywords/u);
    assert.match(prompt, /k1\|k2\|k3\|k4\|k5/u);
  });
});

test('buildTaskSystemPrompt illustrative examples do not bias toward "src/" path prefixes', () => {
  withTempRepo((repoRoot) => {
    const prompt = buildTaskSystemPrompt(repoRoot);

    // The anchor-format example, the `read` JSON example, and the finish-output
    // example all used to start with "src/". Strip that bias so repos with apps/,
    // packages/, or arbitrary layouts are not implicitly disfavored.
    assert.doesNotMatch(prompt, /src\/foo\.ts:45-60/u);
    assert.doesNotMatch(prompt, /src\/config\.ts:42/u);
    assert.doesNotMatch(prompt, /src\/summary\.ts:120-135/u);

    // The illustrative shapes themselves must still be present (path:line range,
    // repo-relative JSON path, finish-output anchor-bullet format).
    assert.match(prompt, /\bdir\/foo\.ts:45-60\b/u);
    assert.match(prompt, /"path":"[^"]+\/[^"]+\.ts"/u);
    assert.match(prompt, /:42 — definition/u);
    assert.match(prompt, /:120-135 — call site/u);
  });
});

// F14 (A10): prompt-text guidance assertions extracted from runTaskLoop loop cases.
test('buildTaskSystemPrompt includes anti-loop and larger single-file read guidance', () => {
  withTempRepo((repoRoot) => {
    const prompt = buildTaskSystemPrompt(repoRoot);
    assert.match(prompt, /Anchor-before-read/u);
    assert.match(prompt, /grep.*anchor|anchor.*grep/iu);
    assert.match(prompt, /`read`/u);
    assert.match(prompt, /one large window per anchor|larger window/u);
    assert.match(prompt, /never tiny|tiny-slice/u);
    assert.match(prompt, /Two reads of the same file must have a grep search between them/u);
    assert.match(prompt, /strengthen the anchor/u);
  });
});

test('buildTaskSystemPrompt examples use larger reads and anchor-first flow', () => {
  withTempRepo((repoRoot) => {
    const prompt = buildTaskSystemPrompt(repoRoot);
    assert.match(prompt, /\{"action":"grep","pattern":"invokePlannerMode"\}/u);
    assert.match(prompt, /\{"action":"find","pattern":"\*\*\/\*\.test\.ts"\}/u);
    assert.match(prompt, /\{"action":"read","path":"dir\/foo\.ts","offset":861,"limit":240\}/u);
    assert.match(prompt, /tiny-slice/u);
  });
});

test('buildTaskSystemPrompt states ignored paths are auto-filtered by runtime policy', () => {
  withTempRepo((repoRoot) => {
    const prompt = buildTaskSystemPrompt(repoRoot);
    assert.match(prompt, /Ignored paths \(node_modules, dist, \.git, …\) are excluded from grep\/find\/ls automatically\./u);
  });
});

test('buildAgentSystemPrompt has persona, full tool list, edit-first guideline, and no search-discipline lines', () => {
  const prompt = buildAgentSystemPrompt(process.cwd(), { includeAgentsMd: false, includeRepoFileListing: true });
  assert.match(prompt, /repository coding agent/iu);
  for (const tool of ['read', 'grep', 'find', 'ls', 'git', 'web_search', 'web_fetch', 'write', 'edit', 'run']) {
    assert.ok(prompt.includes(tool), `expected tool ${tool} in prompt`);
  }
  assert.match(prompt, /"action":"finish"/u);
  assert.match(prompt, /Prefer `edit`/u);
  // Must NOT carry the read-only search-discipline persona.
  assert.doesNotMatch(prompt, /repo-search planner/u);
  assert.doesNotMatch(prompt, /anchor-bullets/u);
  assert.doesNotMatch(prompt, /Minimum 5 tool-call turns/u);
});

test('buildAgentSystemPrompt tells the run tool it is PowerShell on Windows with tail-truncated output', () => {
  const prompt = buildAgentSystemPrompt(process.cwd(), { includeAgentsMd: false, includeRepoFileListing: true });
  // Shell identity is single-sourced from the executor constant, not a duplicated literal.
  assert.ok(RUN_SHELL_LABEL.includes(POWERSHELL_EXECUTABLE), 'label must be built from the executable name');
  assert.ok(prompt.includes(RUN_SHELL_LABEL), 'run tool line must use the executor-derived shell label');
  assert.match(prompt, /Select-Object|Get-Content|Select-String/u, 'must steer to PowerShell idioms');
  assert.match(prompt, /tail/iu, 'must say long output is truncated to the tail');
});

test('buildAgentSystemPrompt injects agents.md when present and enabled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-agent-prompt-'));
  try {
    fs.writeFileSync(path.join(dir, 'agents.md'), 'PROJECT RULE: use tabs.');
    const prompt = buildAgentSystemPrompt(dir, { includeAgentsMd: true, includeRepoFileListing: true });
    assert.match(prompt, /PROJECT RULE: use tabs\./u);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
