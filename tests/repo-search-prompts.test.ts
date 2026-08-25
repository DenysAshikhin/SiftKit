import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  buildAgentSystemPrompt as buildAgentSystemPromptForTools,
  buildCompactionSummaryInstruction,
  buildTaskInitialUserPrompt,
  buildTaskSystemPrompt as buildTaskSystemPromptForTools,
} from '../src/repo-search/prompts.js';
import {
  EXPOSED_REPO_TOOL_NAMES,
  INTERACTIVE_REPO_TOOL_NAMES,
} from '../src/planner-protocol/repo-search.js';
import { APPROVAL_REVIEW_REQUEST_MARKER } from '../src/repo-search/approval-review-policy.js';
import { REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT } from '../src/repo-search/engine/runtime-profile.js';
import { RUN_SHELL_LABEL, POWERSHELL_EXECUTABLE } from '../src/lib/powershell.js';
import {
  PresetSystemContextBuilder,
  type PresetSystemContext,
} from '../src/preset-system-context.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

function withTempRepo(fn: (repoRoot: string) => void): void {
  const repoRoot = createManagedTempDir('siftkit-repo-prompt-');
  try {
    fn(repoRoot);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

function buildTestContext(
  repoRoot: string,
  includeAgentsMd = false,
  includeRepoFileListing = false,
): PresetSystemContext {
  return new PresetSystemContextBuilder(repoRoot).build({
    includeAgentsMd,
    includeRepoFileListing,
    autoloadFiles: [],
  });
}

function buildTaskSystemPrompt(context: PresetSystemContext): string {
  return buildTaskSystemPromptForTools(context, EXPOSED_REPO_TOOL_NAMES);
}

function buildAgentSystemPrompt(context: PresetSystemContext): string {
  return buildAgentSystemPromptForTools(context, INTERACTIVE_REPO_TOOL_NAMES);
}

const SPARSE_PROGRESS_POLICY =
  'Progress is optional. Use it sparingly, only for a meaningful phase change or a checkpoint after substantial work. Do not narrate routine next steps.';

function countOccurrences(text: string, search: string): number {
  return text.split(search).length - 1;
}

test('system prompt action instructions match the request tool surface', () => {
  const context = buildTestContext(process.cwd());
  const reduced = buildTaskSystemPromptForTools(context, ['read']);
  const empty = buildTaskSystemPromptForTools(context, []);

  assert.match(reduced, /Allowed tools: read/u);
  assert.doesNotMatch(reduced, /Allowed tools:.*grep/u);
  assert.doesNotMatch(empty, /Allowed tools:|tool_batch/u);
});

test('restricted and empty agent prompts preserve the completion review instruction', () => {
  const context = buildTestContext(process.cwd());
  const reduced = buildAgentSystemPromptForTools(context, ['read']);
  const empty = buildAgentSystemPromptForTools(context, []);

  for (const prompt of [reduced, empty]) {
    assert.match(prompt, /Before calling finish, re-read the original task and any referenced spec or plan/u);
  }
  assert.match(reduced, /Allowed tools: read/u);
  assert.doesNotMatch(reduced, /Allowed tools:.*grep/u);
  assert.doesNotMatch(empty, /Allowed tools:|tool_batch/u);
});

test('repo prompts render one canonical sparse-progress policy', () => {
  const context = buildTestContext(process.cwd());
  const prompts = [
    buildAgentSystemPrompt(context),
    buildAgentSystemPromptForTools(context, ['read']),
    buildAgentSystemPromptForTools(context, []),
    buildTaskSystemPrompt(context),
  ];

  for (const prompt of prompts) {
    assert.equal(countOccurrences(prompt, SPARSE_PROGRESS_POLICY), 1);
    assert.doesNotMatch(prompt, /scanning scripts next|genuine non-terminal status/u);
  }
});

test('base task prompt and initial user message exclude autoload content', () => {
  const context = {
    content: '--- Autoloaded file: docs/policy.md ---\n\npolicy text',
    warnings: [],
    hasAgentsMd: false,
    hasRepoFileListing: false,
    loadedFiles: ['docs/policy.md'],
  } satisfies PresetSystemContext;

  const system = buildTaskSystemPrompt(context);
  const user = buildTaskInitialUserPrompt('locate policy use');

  assert.doesNotMatch(system, /Autoloaded file|policy text/u);
  assert.doesNotMatch(user, /Autoloaded file|policy text/u);
  assert.equal(user, 'Task: locate policy use');
});

test('buildTaskSystemPrompt omits agents.md block when disabled', () => {
  withTempRepo((repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, 'agents.md'), 'repo policy', 'utf8');

    const prompt = buildTaskSystemPrompt(buildTestContext(repoRoot));

    assert.doesNotMatch(prompt, /agents\.md \(project-specific instructions\)/u);
    assert.doesNotMatch(prompt, /repo policy/u);
  });
});

test('buildTaskInitialUserPrompt omits repository file listing when disabled', () => {
  const prompt = buildTaskInitialUserPrompt('Find planner code');

  assert.equal(prompt, 'Task: Find planner code');
});

test('buildTaskInitialUserPrompt never contains the repository file listing', () => {
  assert.equal(buildTaskInitialUserPrompt('Find planner code'), 'Task: Find planner code');
});

test('buildTaskSystemPrompt advertises the native tool surface and no shell commands', () => {
  withTempRepo((repoRoot) => {
    const prompt = buildTaskSystemPrompt(buildTestContext(repoRoot));

    assert.match(prompt, /Allowed tools: read, grep, find, ls, git/u);
    for (const toolName of ['grep', 'find', 'ls', 'read', 'git']) {
      assert.match(prompt, new RegExp(`"action":"tool","toolName":"${toolName}"`, 'u'));
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
    const prompt = buildTaskSystemPrompt(buildTestContext(repoRoot));

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
    const prompt = buildTaskSystemPrompt(buildTestContext(repoRoot));
    assert.ok(
      prompt.length <= 6000,
      `expected compressed prompt <= 6000 chars, got ${prompt.length}`,
    );
  });
});

test('buildTaskSystemPrompt turn-1 directive searches from the repository root', () => {
  withTempRepo((repoRoot) => {
    const prompt = buildTaskSystemPrompt(buildTestContext(repoRoot));

    // The turn-1 grep recipe must not blind-guess a top-level "src" folder —
    // many repos use apps/runner/src, packages/*/src, etc. The model should
    // search from the repo root with no path so the ignore policy filters noise.
    assert.doesNotMatch(prompt, /"k1\|k2\|k3\|k4\|k5"[^\n]*\bsrc\b/u);

    // The 5-keyword turn-1 rule itself must survive.
    assert.match(prompt, /Turn 1: pick 5 keywords/u);
    assert.match(prompt, /k1\|k2\|k3\|k4\|k5/u);
  });
});

test('buildTaskSystemPrompt renders canonical examples from tool metadata', () => {
  withTempRepo((repoRoot) => {
    const prompt = buildTaskSystemPrompt(buildTestContext(repoRoot));

    assert.match(prompt, /"action":"tool","toolName":"read","args":\{"path":"src\/app\.ts","offset":1,"limit":120\}/u);
    assert.match(prompt, /"action":"tool","toolName":"grep","args":\{"pattern":"buildPlanner"/u);
    assert.match(prompt, /\bdir\/foo\.ts:45-60\b/u);
  });
});

// F14 (A10): prompt-text guidance assertions extracted from runTaskLoop loop cases.
test('buildTaskSystemPrompt includes anti-loop and larger single-file read guidance', () => {
  withTempRepo((repoRoot) => {
    const prompt = buildTaskSystemPrompt(buildTestContext(repoRoot));
    assert.match(prompt, /Anchor-before-read/u);
    assert.match(prompt, /grep.*anchor|anchor.*grep/iu);
    assert.match(prompt, /`read`/u);
    assert.match(prompt, /one large window per anchor|larger window/u);
    assert.match(prompt, /never tiny|tiny-slice/u);
    assert.match(prompt, /strengthen the anchor/u);
  });
});

test('buildTaskSystemPrompt examples use larger reads and anchor-first flow', () => {
  withTempRepo((repoRoot) => {
    const prompt = buildTaskSystemPrompt(buildTestContext(repoRoot));
    assert.match(prompt, /"action":"tool","toolName":"grep","args":\{"pattern":"buildPlanner"/u);
    assert.match(prompt, /"action":"tool","toolName":"find","args":\{"pattern":"\*\*\/\*\.test\.ts"/u);
    assert.match(prompt, /"action":"tool","toolName":"read","args":\{"path":"src\/app\.ts","offset":1,"limit":120\}/u);
    assert.match(prompt, /tiny-slice/u);
  });
});

test('buildTaskSystemPrompt states ignored paths are auto-filtered by runtime policy', () => {
  withTempRepo((repoRoot) => {
    const prompt = buildTaskSystemPrompt(buildTestContext(repoRoot));
    assert.match(prompt, /Ignored paths \(node_modules, dist, \.git, …\) are excluded from grep\/find\/ls automatically\./u);
  });
});

test('buildAgentSystemPrompt has persona, full tool list, edit-first guideline, and no search-discipline lines', () => {
  const prompt = buildAgentSystemPrompt(buildTestContext(process.cwd(), false, true));
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

test('buildAgentSystemPrompt excludes the approval-review policy', () => {
  const prompt = buildAgentSystemPrompt(buildTestContext(process.cwd(), false, true));

  assert.doesNotMatch(prompt, /Approval review policy/u);
  assert.equal(prompt.includes(APPROVAL_REVIEW_REQUEST_MARKER), false);
  assert.doesNotMatch(prompt, /"verdict":"approve"\|"deny"\|"unsure"/u);
});

test('buildTaskSystemPrompt excludes repo-agent approval-review policy', () => {
  const prompt = buildTaskSystemPrompt(buildTestContext(process.cwd(), false, true));

  assert.doesNotMatch(prompt, /Approval review policy/u);
  assert.equal(prompt.includes(APPROVAL_REVIEW_REQUEST_MARKER), false);
});

test('buildAgentSystemPrompt tells the run tool it is PowerShell on Windows with tail-truncated output', () => {
  const prompt = buildAgentSystemPrompt(buildTestContext(process.cwd(), false, true));
  // Shell identity is single-sourced from the executor constant, not a duplicated literal.
  assert.ok(RUN_SHELL_LABEL.includes(POWERSHELL_EXECUTABLE), 'label must be built from the executable name');
  assert.ok(prompt.includes(RUN_SHELL_LABEL), 'run tool line must use the executor-derived shell label');
  assert.match(prompt, /Select-Object|Get-Content|Select-String/u, 'must steer to PowerShell idioms');
  assert.match(prompt, /tail/iu, 'must say long output is truncated to the tail');
});

// A backslash inside a JSON string is an escape, so `dashboard\node_modules` arrives as a real
// newline plus `ode_modules`. Inside a run command that is indistinguishable from an intended
// statement separator and cannot be repaired, so the prompt has to prevent it. Native executables
// may still require backslashes, which must be escaped in the JSON string rather than forbidden.
test('buildAgentSystemPrompt gives safe forward-slash and escaped-backslash path guidance', () => {
  const prompt = buildAgentSystemPrompt(buildTestContext(process.cwd(), false, true));

  assert.match(prompt, /prefer forward slashes for paths/iu);
  assert.match(prompt, /including inside `run` commands/iu);
  assert.match(prompt, /native executable requires backslashes/iu);
  assert.match(prompt, /JSON-escape each one as `\\\\`/u);
  assert.match(prompt, /unescaped backslash in JSON.*corrupt the argument/iu);
});

test('buildAgentSystemPrompt documents automatic validation trimming and full output mode', () => {
  const prompt = buildAgentSystemPrompt(buildTestContext(process.cwd(), false, true));

  assert.match(
    prompt,
    new RegExp(`final ${REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT} lines`, 'u'),
  );
  assert.match(prompt, /test, build, lint, and typecheck/u);
  assert.match(prompt, /outputMode.*"full"/u);
  assert.match(prompt, /raw log streams.*untrimmed text.*required/u);
  assert.match(prompt, /repeat the identical run.*immediately/u);
});

test('buildAgentSystemPrompt requires a completion review against the task and referenced plans', () => {
  const prompt = buildAgentSystemPrompt(buildTestContext(process.cwd(), false, true));

  assert.match(prompt, /Before calling finish/u);
  assert.match(prompt, /re-read the original task/u);
  assert.match(prompt, /referenced spec or plan/u);
  assert.match(prompt, /every requirement/u);
  assert.match(prompt, /verify nothing was missed/u);
});

test('buildAgentSystemPrompt uses context metadata without injecting context content', () => {
  const dir = createManagedTempDir('siftkit-agent-prompt-');
  try {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'PROJECT RULE: use tabs.');
    const prompt = buildAgentSystemPrompt(buildTestContext(dir, true, true));
    assert.match(prompt, /repository file listing is provided/u);
    assert.doesNotMatch(prompt, /PROJECT RULE: use tabs\./u);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildCompactionSummaryInstruction requests the complete resumable summary without embedding history', () => {
  const instruction = buildCompactionSummaryInstruction();

  assert.match(instruction, /Task and goal/u);
  assert.match(instruction, /Current state/u);
  assert.match(instruction, /Key findings/u);
  assert.match(instruction, /Decisions made/u);
  assert.match(instruction, /Tool results that still matter/u);
  assert.match(instruction, /In-flight work/u);
  assert.doesNotMatch(instruction, /BEGIN CONVERSATION TO COMPACT/u);
});

test('buildCompactionSummaryInstruction preserves system instructions outside the replaced history', () => {
  const instruction = buildCompactionSummaryInstruction();

  assert.match(
    instruction,
    /The system instructions above remain active after compaction and must not be repeated in the summary\./u,
  );
  assert.match(
    instruction,
    /Only the completed conversation history above will be replaced by what you write\./u,
  );
  assert.doesNotMatch(instruction, /Nothing else survives\./u);
});
