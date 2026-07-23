# repo-agent Runtime Limits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make repo-agent default to 100 turns, fail without compaction when its context is exhausted, and automatically retain only the final 50 lines from routine validation commands unless full output is explicitly requested.

**Architecture:** Put the repo-agent turn default in `@siftkit/contracts` so backend, dashboard, and direct execution share one value. Carry explicit context-overflow and validation-output policies from `executeRepoSearchRequest` through the existing loop classes; keep non-agent behavior unchanged. Add one typed `ValidationCommandOutputPolicy` class that classifies anchored command segments and trims captured output after execution, preserving the original command and exit code.

**Tech Stack:** TypeScript 5.9, Zod 4, Node test runner, PowerShell command execution, npm workspaces.

## Global Constraints

- Use TDD exclusively: failing test, observed failure, minimal implementation, passing test.
- Prefer end-to-end execution tests where practical; add focused unit tests for classifier branches and line boundaries.
- Keep all new APIs typed and infer IO-boundary types from Zod schemas.
- Do not use `any`, `unknown`-laundering casts, type-assertion casts, non-null assertions, or namespace imports.
- Do not pass functions dynamically; use explicit class methods and typed data.
- Reuse existing loop, prompt, tool, and preset components; do not add shims or legacy behavior.
- `100` is the repo-agent default, not a hard cap. Explicit positive overrides, including values above 100, remain valid.
- Repo-agent uses `contextOverflowPolicy: 'fail'`; plan, repo-search, and chat continue using `'compact'`.
- Validation auto-trimming applies only to repo-agent's native `run` tool.
- `outputMode: 'full'` bypasses only the fixed 50-line cap; normal token-budget fitting remains active.
- Do not use a worktree.
- Do not invoke `siftkit`; all validation commands in this plan are raw.

---

## File Structure

### Create

- `src/repo-search/engine/validation-command-output-policy.ts` — owns the typed run output mode, validation-command classification, and fixed tail trimming.
- `tests/validation-command-output-policy.test.ts` — exhaustively covers classification, false positives, newline formats, and line-count boundaries.

### Modify

- `packages/contracts/src/config.ts` — exports the canonical 100-turn repo-agent default.
- `src/presets.ts` — consumes the canonical default for built-in and custom repo-agent presets.
- `dashboard/src/preset-editor.ts` — consumes the canonical default in editor kind changes.
- `src/repo-search/execute.ts` — selects all repo-agent runtime policies at the task-kind boundary.
- `src/repo-search/engine.ts` — carries overflow and validation-output policies into each task loop.
- `src/repo-search/engine/task-loop-support.ts` — defines typed loop policy options.
- `src/repo-search/engine/task-loop.ts` — supplies policies to `PromptPreparer` and `ToolActionProcessor`.
- `src/repo-search/engine/prompt-preparer.ts` — branches explicitly between compaction and immediate overflow failure.
- `src/repo-search/engine/tool-action-processor.ts` — carries the validation line limit into native tool execution.
- `src/repo-search/engine/repo-tools.ts` — validates `outputMode`, preserves it in synthetic commands, and applies the output policy after PowerShell exits.
- `src/repo-search/planner-protocol.ts` — declares the `outputMode` enum in the model-facing run schema.
- `src/lib/model-json.ts` — runtime-validates model-produced `outputMode`.
- `src/repo-search/prompts.ts` — documents automatic validation trimming and the explicit full-output escape hatch.
- `tests/contracts-config.test.ts` — asserts the shared constant.
- `tests/presets.test.ts` — asserts backend built-in and custom defaults.
- `tests/preset-editor.test.ts` — asserts dashboard defaults.
- `tests/repo-search-agent-execute.test.ts` — verifies direct repo-agent default/override and no-compaction selection.
- `tests/engine-prompt-preparer.test.ts` — verifies both overflow-policy branches and transcript preservation.
- `tests/repo-tools.test.ts` — exercises automatic trimming through a real failing Node test command.
- `tests/model-json.test.ts` — covers valid and invalid model-produced output modes.
- `tests/repo-search-prompts.test.ts` — locks prompt guidance to the shared line-limit constant.

---

### Task 1: Canonical 100-Turn repo-agent Default

**Files:**

- Modify: `packages/contracts/src/config.ts:117-149`
- Modify: `src/presets.ts:1-8,255-271,325-337`
- Modify: `dashboard/src/preset-editor.ts:1-13,67-91`
- Modify: `src/repo-search/execute.ts:1-15,248-337`
- Test: `tests/contracts-config.test.ts`
- Test: `tests/presets.test.ts:65-90,232-247`
- Test: `tests/preset-editor.test.ts:128-146`
- Test: `tests/repo-search-agent-execute.test.ts`

**Interfaces:**

- Produces: `REPO_AGENT_DEFAULT_MAX_TURNS: 100` from `@siftkit/contracts`.
- Consumes: `RepoSearchExecutionRequest.maxTurns?: number`.
- Behavior: `request.maxTurns ?? REPO_AGENT_DEFAULT_MAX_TURNS` only when `taskKind === 'repo-agent'`.

- [ ] **Step 1: Write failing constant, preset, and execution-boundary tests**

In `tests/contracts-config.test.ts`, import and assert the constant:

```ts
import {
  Exl3EngineConfigSchema,
  InferenceRuntimeStatusSchema,
  ModelRuntimePresetSchema,
  REPO_AGENT_DEFAULT_MAX_TURNS,
  RestartBackendResponseSchema,
  ServerModelPresetsConfigSchema,
  SiftConfigSchema,
} from '@siftkit/contracts';

test('repo-agent turn default is shared through the contracts package', () => {
  assert.equal(REPO_AGENT_DEFAULT_MAX_TURNS, 100);
});
```

Change the repo-agent assertions in `tests/presets.test.ts` and `tests/preset-editor.test.ts`:

```ts
assert.equal(agent.maxTurns, 100);
```

```ts
assert.equal(found.maxTurns, 100);
```

```ts
assert.equal(preset.maxTurns, 100);
```

Add a progress-based boundary test to `tests/repo-search-agent-execute.test.ts`:

```ts
import type { RepoSearchProgressEvent } from '../src/repo-search/types.js';
import { CollectingProgressWriter } from './helpers/collecting-progress-writer.js';

async function readRepoAgentMaxTurns(requestedMaxTurns?: number): Promise<number | undefined> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-agent-turns-'));
  const events: RepoSearchProgressEvent[] = [];
  try {
    await executeRepoSearchRequest({
      taskKind: 'repo-agent',
      prompt: 'finish immediately',
      repoRoot: dir,
      config: MOCK_CONFIG,
      model: 'mock',
      ...(requestedMaxTurns === undefined ? {} : { maxTurns: requestedMaxTurns }),
      includeAgentsMd: false,
      includeRepoFileListing: false,
      allowedTools: [...INTERACTIVE_REPO_TOOL_NAMES],
      availableModels: ['mock'],
      mockResponses: ['{"action":"finish","output":"done"}'],
      mockCommandResults: {},
      progressWriter: new CollectingProgressWriter(events),
    });
    return events.find((event) => event.kind === 'llm_start')?.maxTurns;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('repo-agent defaults to 100 turns and preserves an explicit higher override', async () => {
  assert.equal(await readRepoAgentMaxTurns(), 100);
  assert.equal(await readRepoAgentMaxTurns(125), 125);
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```powershell
npm test -- contracts-config presets preset-editor repo-search-agent-execute
```

Expected: FAIL because `REPO_AGENT_DEFAULT_MAX_TURNS` is not exported and existing defaults resolve to 80 or 45.

- [ ] **Step 3: Add the canonical constant and replace duplicated preset literals**

In `packages/contracts/src/config.ts`, place the constant beside the canonical preset groupings:

```ts
export const REPO_AGENT_DEFAULT_MAX_TURNS = 100;
```

In `src/presets.ts`, add the named import:

```ts
import {
  FULL_PRESET_TOOLS,
  PresetToolNameSchema,
  READ_ONLY_PRESET_TOOLS,
  REPO_AGENT_DEFAULT_MAX_TURNS,
  SUMMARY_PRESET_TOOLS,
  type PresetToolName,
} from '@siftkit/contracts';
```

Replace both repo-agent `80` literals:

```ts
maxTurns: REPO_AGENT_DEFAULT_MAX_TURNS,
```

```ts
maxTurns: normalizeNullableInteger(
  reader.value('maxTurns'),
  presetKind === 'repo-agent'
    ? REPO_AGENT_DEFAULT_MAX_TURNS
    : (presetKind === 'plan' || presetKind === 'repo-search' ? 45 : null),
),
```

In `dashboard/src/preset-editor.ts`, import and use the same constant:

```ts
import {
  FULL_PRESET_TOOLS,
  READ_ONLY_PRESET_TOOLS,
  REPO_AGENT_DEFAULT_MAX_TURNS,
  SUMMARY_PRESET_TOOLS,
} from '@siftkit/contracts';
```

```ts
if (preset.presetKind === 'repo-agent') {
  preset.repoRootRequired = true;
  preset.maxTurns = preset.maxTurns || REPO_AGENT_DEFAULT_MAX_TURNS;
  return;
}
```

- [ ] **Step 4: Resolve omitted direct/CLI requests at the repo-agent boundary**

In `src/repo-search/execute.ts`, import the constant:

```ts
import { REPO_AGENT_DEFAULT_MAX_TURNS } from '@siftkit/contracts';
```

Change only the `runRepoSearch` call's `maxTurns` field:

```ts
maxTurns: request.maxTurns ?? (isAgent ? REPO_AGENT_DEFAULT_MAX_TURNS : undefined),
```

Do not clamp explicit values.

- [ ] **Step 5: Run the focused tests and verify they pass**

Run:

```powershell
npm test -- contracts-config presets preset-editor repo-search-agent-execute
```

Expected: PASS; the progress event reports 100 with no override and 125 with an explicit override.

- [ ] **Step 6: Commit Task 1**

```powershell
git add packages/contracts/src/config.ts src/presets.ts dashboard/src/preset-editor.ts src/repo-search/execute.ts tests/contracts-config.test.ts tests/presets.test.ts tests/preset-editor.test.ts tests/repo-search-agent-execute.test.ts
git commit -m "feat: default repo-agent to 100 turns"
```

---

### Task 2: Fail repo-agent on Context Exhaustion Without Compaction

**Files:**

- Modify: `src/repo-search/engine/task-loop-support.ts:144-170`
- Modify: `src/repo-search/engine.ts:163-255`
- Modify: `src/repo-search/engine/task-loop.ts:116-260`
- Modify: `src/repo-search/engine/prompt-preparer.ts:10-190`
- Modify: `src/repo-search/execute.ts:315-340`
- Test: `tests/engine-prompt-preparer.test.ts`
- Test: `tests/repo-search-agent-execute.test.ts`

**Interfaces:**

- Produces: `ContextOverflowPolicy = 'compact' | 'fail'`.
- Produces: `RunTaskLoopOptions.contextOverflowPolicy?: ContextOverflowPolicy`.
- Consumes: `PromptPreparer.options.contextOverflowPolicy: ContextOverflowPolicy`.
- Logging: `turn_preflight_budget` and `turn_preflight_overflow_fail` include `contextOverflowPolicy`.

- [ ] **Step 1: Write failing focused policy tests**

Update `tests/engine-prompt-preparer.test.ts` imports and helper:

```ts
import type { JsonSerializable } from '../src/lib/json-types.js';
import type { ContextOverflowPolicy } from '../src/repo-search/engine/task-loop-support.js';

function makePreparer(
  budget: TurnBudget,
  transcript: TranscriptManager,
  contextOverflowPolicy: ContextOverflowPolicy = 'compact',
  events: Array<Record<string, JsonSerializable>> = [],
): PromptPreparer {
  return new PromptPreparer({
    taskId: 't1',
    model: 'mock-model',
    config: undefined,
    useEstimatedTokensOnly: true,
    budget,
    plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(),
    thinkingEnabled: false,
    reasoningContentEnabled: false,
    preserveThinking: false,
    contextOverflowPolicy,
    transcript,
    progress: new ProgressReporter({
      progressWriter: new SilentProgressWriter<RepoSearchProgressEvent>(),
      taskId: 't1',
      maxTurns: 45,
      taskStartedAt: Date.now(),
    }),
    logger: {
      path: 'memory',
      write(event: Record<string, JsonSerializable>): void {
        events.push(event);
      },
    },
    timingRecorder: null,
  });
}
```

Add a fixture where dropping old assistant history would make the prompt fit:

```ts
function makeCompactableTranscript(): TranscriptManager {
  return new TranscriptManager({
    systemPromptContent: 'SYSTEM',
    historyMessages: [{ role: 'assistant', content: 'H'.repeat(24_000) }],
    initialUserContent: 'question',
  });
}

test('prepareTurn fail policy preserves overflowing transcript and skips compaction', async () => {
  const transcript = makeCompactableTranscript();
  const originalMessages = JSON.stringify(transcript.getMessages());
  const events: Array<Record<string, JsonSerializable>> = [];
  const preparer = makePreparer(
    new TurnBudget({ totalContextTokens: 9_000, maxTurns: 45 }),
    transcript,
    'fail',
    events,
  );

  await assert.rejects(
    preparer.prepareTurn(1),
    /planner_preflight_overflow.*context_overflow_policy=fail/u,
  );

  assert.equal(JSON.stringify(transcript.getMessages()), originalMessages);
  assert.equal(events.some((event) => event.kind === 'turn_preflight_compaction_applied'), false);
  const overflow = events.find((event) => event.kind === 'turn_preflight_overflow_fail');
  assert.equal(overflow?.contextOverflowPolicy, 'fail');
});

test('prepareTurn compact policy compacts the same transcript and continues', async () => {
  const transcript = makeCompactableTranscript();
  const beforeLength = transcript.length;
  const events: Array<Record<string, JsonSerializable>> = [];
  const preparer = makePreparer(
    new TurnBudget({ totalContextTokens: 9_000, maxTurns: 45 }),
    transcript,
    'compact',
    events,
  );

  const result = await preparer.prepareTurn(1);

  assert.ok(result.promptTokenCount > 0);
  assert.ok(transcript.length < beforeLength);
  assert.equal(events.some((event) => event.kind === 'turn_preflight_compaction_applied'), true);
});
```

Add an execution-boundary test to `tests/repo-search-agent-execute.test.ts`:

```ts
test('repo-agent selects fail context policy and surfaces overflow without a model call', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-agent-overflow-'));
  try {
    await assert.rejects(
      executeRepoSearchRequest({
        taskKind: 'repo-agent',
        prompt: 'Q'.repeat(60_000),
        repoRoot: dir,
        config: mockSiftConfig({ Runtime: { LlamaCpp: { NumCtx: 9_000 } } }),
        model: 'mock',
        includeAgentsMd: false,
        includeRepoFileListing: false,
        allowedTools: [...INTERACTIVE_REPO_TOOL_NAMES],
        availableModels: ['mock'],
        mockResponses: ['{"action":"finish","output":"must not run"}'],
        mockCommandResults: {},
      }),
      /planner_preflight_overflow.*context_overflow_policy=fail/u,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```powershell
npm test -- engine-prompt-preparer repo-search-agent-execute
```

Expected: FAIL because `ContextOverflowPolicy` and `contextOverflowPolicy` do not exist and repo-agent still compacts.

- [ ] **Step 3: Add the typed overflow policy and carry it through the loop**

In `src/repo-search/engine/task-loop-support.ts`:

```ts
export type ContextOverflowPolicy = 'compact' | 'fail';

export type RunTaskLoopOptions = {
  repoRoot: string;
  model: string;
  baseUrl: string;
  config?: SiftConfig;
  totalContextTokens?: number;
  timeoutMs?: number;
  maxTurns?: number;
  maxInvalidResponses?: number;
  minToolCallsBeforeFinish?: number;
  contextOverflowPolicy?: ContextOverflowPolicy;
  loopKind?: 'repo-search' | 'chat';
};
```

Add only `contextOverflowPolicy`; retain the remaining currently-declared fields after `loopKind`.

In `src/repo-search/engine.ts`, import the type, add the public option, and explicitly resolve the non-agent default:

```ts
import type { ContextOverflowPolicy } from './engine/task-loop-support.js';
```

```ts
contextOverflowPolicy?: ContextOverflowPolicy;
```

```ts
contextOverflowPolicy: options.contextOverflowPolicy ?? 'compact',
```

In `src/repo-search/engine/task-loop.ts`, pass the resolved policy into `PromptPreparer`:

```ts
contextOverflowPolicy: options.contextOverflowPolicy ?? 'compact',
```

- [ ] **Step 4: Make PromptPreparer branch before compaction**

Add the required constructor field in `src/repo-search/engine/prompt-preparer.ts`:

```ts
import type { ContextOverflowPolicy } from './task-loop-support.js';
```

```ts
contextOverflowPolicy: ContextOverflowPolicy;
```

Add the policy to the initial budget log:

```ts
contextOverflowPolicy: this.options.contextOverflowPolicy,
```

Change the existing compaction guard from `if (!preflight.ok) {` to:

```ts
if (!preflight.ok && this.options.contextOverflowPolicy === 'compact') {
}
```

Keep the current compaction block body inside that guard without changing its calculations or events.

Include the explicit policy in the error and failure event:

```ts
const overflowError = new Error(
  `planner_preflight_overflow prompt_tokens=${preflight.promptTokenCount} ` +
    `max_prompt_tokens=${preflight.maxPromptBudget} overflow_tokens=${preflight.overflowTokens} ` +
    `max_output_tokens=${maxOutputTokens} total_context_tokens=${budget.totalContextTokens} ` +
    `thinking_buffer_tokens=${budget.thinkingBufferTokens} ` +
    `context_overflow_policy=${this.options.contextOverflowPolicy}`,
);
```

```ts
contextOverflowPolicy: this.options.contextOverflowPolicy,
```

Do not call `transcript.replaceWith` anywhere in the `fail` branch.

- [ ] **Step 5: Select fail only for repo-agent**

In the `runRepoSearch` call in `src/repo-search/execute.ts`:

```ts
contextOverflowPolicy: isAgent ? 'fail' : 'compact',
```

This selection must remain beside the other task-kind-specific settings.

- [ ] **Step 6: Run focused loop and integration tests**

Run:

```powershell
npm test -- engine-prompt-preparer mock-repo-search-loop repo-search-agent-execute
```

Expected: PASS. Existing `runTaskLoop applies one-pass compaction` coverage must continue passing for the default compact policy.

- [ ] **Step 7: Commit Task 2**

```powershell
git add src/repo-search/engine/task-loop-support.ts src/repo-search/engine.ts src/repo-search/engine/task-loop.ts src/repo-search/engine/prompt-preparer.ts src/repo-search/execute.ts tests/engine-prompt-preparer.test.ts tests/repo-search-agent-execute.test.ts
git commit -m "feat: fail repo-agent on context exhaustion"
```

---

### Task 3: Validation Command Classification and Tail Policy

**Files:**

- Create: `src/repo-search/engine/validation-command-output-policy.ts`
- Create: `tests/validation-command-output-policy.test.ts`

**Interfaces:**

- Produces: `RunOutputModeSchema`, `RunOutputMode`, `REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT`.
- Produces: `ValidationCommandOutputPolicy.isValidationCommand(command: string): boolean`.
- Produces: `ValidationCommandOutputPolicy.apply(options): string`.

- [ ] **Step 1: Write exhaustive failing classifier and trimming tests**

Create `tests/validation-command-output-policy.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT,
  ValidationCommandOutputPolicy,
} from '../src/repo-search/engine/validation-command-output-policy.js';

const policy = new ValidationCommandOutputPolicy(REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT);

test('classifies supported validation command families', () => {
  const commands = [
    'npm test',
    'npm run test:coverage',
    'pnpm build',
    'yarn lint:fix',
    'bun run typecheck',
    'node --test tests/a.test.ts',
    'npx vitest run',
    'pnpm exec eslint .',
    'tsc --noEmit',
    'python -m pytest -q',
    'ruff check .',
    'mypy src',
    'dotnet test',
    'cargo clippy',
    'go vet ./...',
    '.\\gradlew.bat build',
    'mvn verify',
    'cmake --build build',
    'ctest --test-dir build',
    '$env:NODE_ENV="test"; npm run test:unit',
    '; npm test',
  ];

  for (const command of commands) {
    assert.equal(policy.isValidationCommand(command), true, command);
  }
});

test('does not classify discovery, display, or unrelated commands', () => {
  const commands = [
    'rg -n "npm test" src',
    'Get-Content tests/a.ts',
    'Write-Output "dotnet test"',
    'npm run deploy',
    'node scripts/build-report.js',
    'git diff -- tests',
    'Get-ChildItem build',
  ];

  for (const command of commands) {
    assert.equal(policy.isValidationCommand(command), false, command);
  }
});

test('leaves zero through 50 validation output lines unchanged', () => {
  for (const lineCount of [0, 49, 50]) {
    const output = Array.from({ length: lineCount }, (_, index) => `line-${index + 1}`).join('\n');
    assert.equal(policy.apply({ command: 'npm test', output, outputMode: 'auto' }), output);
  }
});

test('retains exactly the final 50 lines and reports omissions', () => {
  const output = Array.from({ length: 51 }, (_, index) => `line-${index + 1}`).join('\n');
  const trimmed = policy.apply({ command: 'npm test', output, outputMode: 'auto' });
  const lines = trimmed.split('\n');

  assert.equal(lines.length, 51);
  assert.equal(lines[0], '1 line omitted from validation command output.');
  assert.equal(lines[1], 'line-2');
  assert.equal(lines[50], 'line-51');
});

test('pluralizes the omission notice', () => {
  const output = Array.from({ length: 52 }, (_, index) => `line-${index + 1}`).join('\n');
  const trimmed = policy.apply({ command: 'npm test', output, outputMode: 'auto' });
  assert.match(trimmed, /^2 lines omitted from validation command output\./u);
});

test('handles CRLF and CR while preserving the same final logical lines', () => {
  for (const separator of ['\r\n', '\r']) {
    const output = `${Array.from({ length: 51 }, (_, index) => `line-${index + 1}`).join(separator)}${separator}`;
    const trimmed = policy.apply({ command: 'dotnet test', output, outputMode: 'auto' });
    assert.match(trimmed, /^1 line omitted from validation command output\.\nline-2/u);
    assert.match(trimmed, /line-51$/u);
  }
});

test('full mode and non-validation commands bypass the fixed line cap', () => {
  const output = Array.from({ length: 51 }, (_, index) => `line-${index + 1}`).join('\n');
  assert.equal(policy.apply({ command: 'npm test', output, outputMode: 'full' }), output);
  assert.equal(policy.apply({ command: 'rg test src', output, outputMode: 'auto' }), output);
});
```

- [ ] **Step 2: Run the new test and verify module-not-found failure**

Run:

```powershell
npm test -- validation-command-output-policy
```

Expected: FAIL because `validation-command-output-policy.ts` does not exist.

- [ ] **Step 3: Implement the typed policy class**

Create `src/repo-search/engine/validation-command-output-policy.ts`:

```ts
import { z } from '../../lib/zod.js';

export const REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT = 50;

export const RunOutputModeSchema = z.enum(['auto', 'full']);
export type RunOutputMode = z.infer<typeof RunOutputModeSchema>;

const VALIDATION_COMMAND_PATTERNS = [
  /^(?:&\s*)?(?:npm(?:\.cmd)?|pnpm(?:\.cmd)?|yarn(?:\.cmd)?|bun(?:\.exe)?)\s+(?:run\s+)?(?:test|build|lint|typecheck)(?::[a-z0-9_.-]+)?(?:\s|$)/iu,
  /^(?:&\s*)?node(?:\.exe)?\s+(?=[^;|]*--test(?:[=\s]|$))/iu,
  /^(?:&\s*)?(?:jest|vitest|mocha|ava|eslint|tsc)(?:\.cmd)?(?:\s|$)/iu,
  /^(?:&\s*)?(?:(?:npx|bunx)(?:\.cmd)?|pnpm(?:\.cmd)?\s+exec|yarn(?:\.cmd)?\s+exec)\s+(?:jest|vitest|mocha|ava|eslint|tsc|playwright|cypress)(?:\.cmd)?(?:\s|$)/iu,
  /^(?:&\s*)?(?:playwright(?:\.cmd)?\s+test|cypress(?:\.cmd)?\s+run)(?:\s|$)/iu,
  /^(?:&\s*)?(?:python(?:3)?(?:\.exe)?\s+-m\s+pytest|pytest(?:\.exe)?|ruff(?:\.exe)?(?:\s+check)?|mypy(?:\.exe)?|pyright(?:\.cmd)?)(?:\s|$)/iu,
  /^(?:&\s*)?dotnet(?:\.exe)?\s+(?:build|test)(?:\s|$)/iu,
  /^(?:&\s*)?cargo(?:\.exe)?\s+(?:build|test|check|clippy)(?:\s|$)/iu,
  /^(?:&\s*)?go(?:\.exe)?\s+(?:build|test|vet)(?:\s|$)/iu,
  /^(?:&\s*)?(?:\.?[\\/])?(?:gradle|gradlew)(?:\.bat)?\b.*\s(?::[a-z0-9_.-]+:)?(?:build|test|check)[a-z0-9_.-]*(?:\s|$)/iu,
  /^(?:&\s*)?(?:\.?[\\/])?(?:mvn|mvnw)(?:\.cmd)?\b.*\s(?:compile|package|test|verify|check)(?:\s|$)/iu,
  /^(?:&\s*)?cmake(?:\.exe)?\s+--build(?:\s|$)/iu,
  /^(?:&\s*)?ctest(?:\.exe)?(?:\s|$)/iu,
] as const;

export class ValidationCommandOutputPolicy {
  private readonly lineLimit: number;

  constructor(lineLimit: number) {
    this.lineLimit = Math.max(1, Math.trunc(lineLimit));
  }

  isValidationCommand(command: string): boolean {
    const segments = String(command || '').split(/;|&&|\|\|/u);
    for (const rawSegment of segments) {
      const segment = rawSegment.trim();
      if (!segment) {
        continue;
      }
      for (const pattern of VALIDATION_COMMAND_PATTERNS) {
        if (pattern.test(segment)) {
          return true;
        }
      }
    }
    return false;
  }

  apply(options: {
    command: string;
    output: string;
    outputMode: RunOutputMode;
  }): string {
    if (options.outputMode === 'full' || !this.isValidationCommand(options.command)) {
      return options.output;
    }
    const lines = options.output.split(/\r\n|\r|\n/u);
    if (lines[lines.length - 1] === '') {
      lines.pop();
    }
    if (lines.length <= this.lineLimit) {
      return options.output;
    }
    const omittedLineCount = lines.length - this.lineLimit;
    const noun = omittedLineCount === 1 ? 'line' : 'lines';
    return [
      `${omittedLineCount} ${noun} omitted from validation command output.`,
      ...lines.slice(-this.lineLimit),
    ].join('\n');
  }
}
```

- [ ] **Step 4: Run classifier tests and correct only observed gaps**

Run:

```powershell
npm test -- validation-command-output-policy
```

Expected: PASS. If a listed positive fails, correct its anchored family pattern; do not replace classification with loose substring matching.

- [ ] **Step 5: Commit Task 3**

```powershell
git add src/repo-search/engine/validation-command-output-policy.ts tests/validation-command-output-policy.test.ts
git commit -m "feat: classify and trim validation output"
```

---

### Task 4: Wire repo-agent Validation Trimming, Schema, and Prompt Guidance

**Files:**

- Modify: `src/repo-search/engine/task-loop-support.ts:144-170`
- Modify: `src/repo-search/engine.ts:163-255`
- Modify: `src/repo-search/execute.ts:315-340`
- Modify: `src/repo-search/engine/task-loop.ts:235-290`
- Modify: `src/repo-search/engine/tool-action-processor.ts:95-130,462-490`
- Modify: `src/repo-search/engine/repo-tools.ts:1-65,89-180,668-685`
- Modify: `src/repo-search/planner-protocol.ts:190-205`
- Modify: `src/lib/model-json.ts:50-75,430-475`
- Modify: `src/repo-search/prompts.ts:288-327`
- Test: `tests/repo-tools.test.ts`
- Test: `tests/model-json.test.ts`
- Test: `tests/repo-search-prompts.test.ts`
- Test: `tests/repo-search-agent-execute.test.ts`

**Interfaces:**

- Consumes: `REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT`.
- Produces: `RunTaskLoopOptions.validationCommandOutputLineLimit?: number | null`.
- Produces: `RepoToolContext.validationCommandOutputLineLimit: number | null`.
- Model-facing run args: `{ command: string; timeout?: number; outputMode?: 'auto' | 'full' }`.

- [ ] **Step 1: Write failing model-schema tests**

Add to `tests/model-json.test.ts`:

```ts
test('ModelJson accepts typed run output modes and rejects invalid values', () => {
  assert.deepEqual(
    parseRepoSearchPlannerAction(
      '{"action":"run","command":"npm test","outputMode":"full"}',
      ['run'],
    ),
    {
      action: 'tool',
      tool_name: 'run',
      args: { command: 'npm test', outputMode: 'full' },
    },
  );

  assert.throws(
    () => parseRepoSearchPlannerAction(
      '{"action":"run","command":"npm test","outputMode":"verbose"}',
      ['run'],
    ),
    /invalid planner tool action/u,
  );
});
```

- [ ] **Step 2: Write failing real-command integration tests**

Change `makeContext` in `tests/repo-tools.test.ts`:

```ts
function makeContext(root: string, validationCommandOutputLineLimit: number | null = null) {
  return {
    repoRoot: root,
    ignorePolicy: buildIgnorePolicy(root),
    webTools: makeWebTools(),
    expandReads: true,
    agentRunId: 'test-run',
    validationCommandOutputLineLimit,
  };
}
```

Add a helper and real failing Node test command:

```ts
function writeNoisyFailingTest(root: string): void {
  fs.writeFileSync(
    path.join(root, 'validation.test.cjs'),
    [
      "const test = require('node:test');",
      "const assert = require('node:assert/strict');",
      "test('noisy failure', () => {",
      "  for (let index = 1; index <= 60; index += 1) console.log(`validation-line-${index}`);",
      "  assert.fail('intentional validation failure');",
      '});',
    ].join('\n'),
    'utf8',
  );
}

test('repo-agent run auto mode keeps 50 tail lines and preserves failing exit code', async () => {
  const root = makeRepo();
  try {
    writeNoisyFailingTest(root);
    const result = await executeRepoTool(
      'run',
      { command: 'node --test validation.test.cjs' },
      makeContext(root, 50),
    );

    assert.ok(result.ok);
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /^\d+ lines omitted from validation command output\./u);
    assert.doesNotMatch(result.output, /validation-line-1\b/u);
    assert.match(result.output, /validation-line-60\b/u);
    assert.equal(result.output.split(/\r\n|\r|\n/u).length, 51);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('run full mode and non-agent context preserve complete validation output', async () => {
  const root = makeRepo();
  try {
    writeNoisyFailingTest(root);
    const full = await executeRepoTool(
      'run',
      { command: 'node --test validation.test.cjs', outputMode: 'full' },
      makeContext(root, 50),
    );
    const nonAgent = await executeRepoTool(
      'run',
      { command: 'node --test validation.test.cjs' },
      makeContext(root),
    );

    assert.ok(full.ok);
    assert.ok(nonAgent.ok);
    assert.equal(full.exitCode, 1);
    assert.equal(nonAgent.exitCode, 1);
    assert.match(full.output, /validation-line-1\b/u);
    assert.match(nonAgent.output, /validation-line-1\b/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('run rejects an invalid output mode at the execution boundary', async () => {
  const root = makeRepo();
  try {
    const result = await executeRepoTool(
      'run',
      { command: 'Write-Output marker', outputMode: 'verbose' },
      makeContext(root, 50),
    );
    assert.equal(result.ok, false);
    assert.match(result.reason, /outputMode must be "auto" or "full"/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Write a failing repo-agent end-to-end trimming test**

Add to `tests/repo-search-agent-execute.test.ts`:

```ts
test('repo-agent automatically trims noisy validation run output', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-agent-validation-'));
  fs.writeFileSync(
    path.join(dir, 'validation.test.cjs'),
    [
      "const test = require('node:test');",
      "test('noisy pass', () => {",
      "  for (let index = 1; index <= 60; index += 1) console.log(`validation-line-${index}`);",
      '});',
    ].join('\n'),
    'utf8',
  );
  try {
    const result = await executeRepoSearchRequest({
      taskKind: 'repo-agent',
      prompt: 'run the validation test',
      repoRoot: dir,
      config: MOCK_CONFIG,
      model: 'mock',
      maxTurns: 4,
      includeAgentsMd: false,
      includeRepoFileListing: false,
      allowedTools: [...INTERACTIVE_REPO_TOOL_NAMES],
      availableModels: ['mock'],
      mockResponses: [
        '{"action":"run","command":"node --test validation.test.cjs"}',
        '{"action":"finish","output":"validation passed"}',
      ],
      mockCommandResults: {},
    });
    const command = result.scorecard.tasks[0]?.commands[0];
    if (!command) {
      throw new Error('Expected repo-agent to record the validation command.');
    }
    assert.equal(command.exitCode, 0);
    assert.match(command.output, /lines omitted from validation command output\./u);
    assert.doesNotMatch(command.output, /validation-line-1\b/u);
    assert.match(command.output, /validation-line-60\b/u);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 4: Write failing prompt test**

Extend `tests/repo-search-prompts.test.ts`:

```ts
import { REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT } from '../src/repo-search/engine/validation-command-output-policy.js';

test('buildAgentSystemPrompt documents automatic validation trimming and full output mode', () => {
  const prompt = buildAgentSystemPrompt(process.cwd(), {
    includeAgentsMd: false,
    includeRepoFileListing: true,
  });

  assert.match(
    prompt,
    new RegExp(`final ${REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT} lines`, 'u'),
  );
  assert.match(prompt, /test, build, lint, and typecheck/u);
  assert.match(prompt, /outputMode.*"full"/u);
  assert.match(prompt, /complete output is required/u);
});
```

- [ ] **Step 5: Run focused tests and verify all behavior groups fail**

Run:

```powershell
npm test -- repo-tools model-json repo-search-prompts repo-search-agent-execute
```

Expected: FAIL because run does not declare/validate `outputMode`, contexts lack the line-limit policy, and the prompt lacks the new guidance.

- [ ] **Step 6: Add outputMode to structured and runtime validation**

In `src/repo-search/planner-protocol.ts`, extend the run properties:

```ts
outputMode: {
  type: 'string',
  enum: ['auto', 'full'],
  description: 'Validation output mode. auto keeps the final 50 lines; full requests complete output before normal context fitting.',
},
```

In `src/lib/model-json.ts`, import the schema:

```ts
import { RunOutputModeSchema } from '../repo-search/engine/validation-command-output-policy.js';
```

Keep `outputMode` out of the generic passthrough list:

```ts
run: { requiredText: ['command'], optional: ['timeout'] },
```

After generic optional fields are copied in `normalizeRepoSearchToolCall`, validate the run-only field:

```ts
if (toolName === 'run' && rawArgs.outputMode !== undefined) {
  const outputMode = RunOutputModeSchema.safeParse(rawArgs.outputMode);
  if (!outputMode.success) {
    return null;
  }
args.outputMode = outputMode.data;
}
```

- [ ] **Step 7: Carry the repo-agent line limit through existing loop classes**

In `src/repo-search/engine/task-loop-support.ts`, add:

```ts
validationCommandOutputLineLimit?: number | null;
```

Add the same option to `runRepoSearch` in `src/repo-search/engine.ts`, then pass it into `runTaskLoop`:

```ts
validationCommandOutputLineLimit?: number | null;
```

```ts
validationCommandOutputLineLimit: options.validationCommandOutputLineLimit ?? null,
```

In `src/repo-search/execute.ts`, import the shared line constant and select it only for repo-agent:

```ts
import { REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT } from './engine/validation-command-output-policy.js';
```

```ts
validationCommandOutputLineLimit: isAgent
  ? REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT
  : null,
```

In `ToolActionProcessorDeps`:

```ts
validationCommandOutputLineLimit: number | null;
```

In `TaskLoop.buildToolActionProcessor`:

```ts
validationCommandOutputLineLimit: options.validationCommandOutputLineLimit ?? null,
```

In `ToolActionProcessor.runNativeExecution`, add the context field:

```ts
validationCommandOutputLineLimit: this.deps.validationCommandOutputLineLimit,
```

- [ ] **Step 8: Validate outputMode and apply the policy after PowerShell exits**

In `src/repo-search/engine/repo-tools.ts`, import:

```ts
import {
  RunOutputModeSchema,
  ValidationCommandOutputPolicy,
} from './validation-command-output-policy.js';
```

Extend `RepoToolContext`:

```ts
validationCommandOutputLineLimit: number | null;
```

Make synthetic commands distinguish `full` from default auto mode so duplicate detection does not block an intentional full-output retry:

```ts
if (toolName === 'run') {
  return formatToolCommand('run', [
    ['command', readString(args.command)],
    ['outputMode', optionalString(args.outputMode)],
  ]);
}
```

Replace `executeRun` with:

```ts
async function executeRun(args: JsonObject, context: RepoToolContext): Promise<RepoToolExecution> {
  const command = buildRepoToolRequestedCommand('run', args);
  const commandText = readString(args.command);
  if (!commandText) {
    return failure('run', command, 'run requires args.command');
  }
  const outputMode = RunOutputModeSchema.safeParse(args.outputMode ?? 'auto');
  if (!outputMode.success) {
    return failure('run', command, 'run outputMode must be "auto" or "full"');
  }
  const timeoutSeconds = optionalPositive(args.timeout);
  const result = await spawnPowerShellAsync(commandText, {
    cwd: context.repoRoot,
    abortSignal: context.abortSignal,
    timeoutMs: timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000,
    env: { [AGENT_RUN_ID_ENV]: context.agentRunId },
  });
  const output = context.validationCommandOutputLineLimit === null
    ? result.output
    : new ValidationCommandOutputPolicy(context.validationCommandOutputLineLimit).apply({
      command: commandText,
      output: result.output,
      outputMode: outputMode.data,
    });
  return {
    ok: true,
    requestedCommand: command,
    command,
    exitCode: result.exitCode,
    output,
    toolType: 'run',
    outputUnit: 'lines',
    outputKeep: 'tail',
  };
}
```

- [ ] **Step 9: Update repo-agent prompt guidance from the shared constant**

In `src/repo-search/prompts.ts`, import:

```ts
import { REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT } from './engine/validation-command-output-policy.js';
```

Replace the current generic long-run-output line and extend the validation guidance:

```ts
`- Long \`run\` output is truncated to its tail, so final summaries and errors survive.`,
`- Test, build, lint, and typecheck commands automatically retain only their final ${REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT} lines in normal \`outputMode: "auto"\`; do not add tail pipelines or temporary redirection.`,
'- Use `outputMode: "full"` only when complete output is required for diagnosis; normal context-budget fitting still applies.',
```

Keep the existing instruction to run relevant build, test, and lint checks.

- [ ] **Step 10: Run focused behavior tests**

Run:

```powershell
npm test -- validation-command-output-policy repo-tools model-json repo-search-prompts repo-search-agent-execute
```

Expected: PASS. The real failing Node test must retain exit code 1 while auto output contains only the omission notice plus 50 tail lines.

- [ ] **Step 11: Run full type, test, and coverage validation**

Run:

```powershell
npm run typecheck
npm test
npm run test:coverage
git diff --check
```

Expected:

- typecheck and lint complete with exit code 0;
- all tests pass;
- coverage reports every branch in `validation-command-output-policy.ts` exercised;
- existing compaction tests remain green;
- `git diff --check` emits no output.

If coverage exposes an untested classifier or overflow branch, add the smallest direct test for that branch before continuing.

- [ ] **Step 12: Commit Task 4**

```powershell
git add src/repo-search/engine/task-loop-support.ts src/repo-search/engine.ts src/repo-search/execute.ts src/repo-search/engine/task-loop.ts src/repo-search/engine/tool-action-processor.ts src/repo-search/engine/repo-tools.ts src/repo-search/planner-protocol.ts src/lib/model-json.ts src/repo-search/prompts.ts tests/repo-tools.test.ts tests/model-json.test.ts tests/repo-search-prompts.test.ts tests/repo-search-agent-execute.test.ts
git commit -m "feat: trim repo-agent validation output"
```

---

## Final Verification Checklist

- [ ] `repo-agent` without `maxTurns` reports `t1/100`.
- [ ] Explicit `maxTurns: 125` reports `t1/125`.
- [ ] Repo-search and plan still use their existing 45-turn default.
- [ ] Repo-agent context overflow throws `planner_preflight_overflow` with `context_overflow_policy=fail`.
- [ ] Repo-agent overflow leaves its transcript unchanged and emits no compaction event.
- [ ] Non-agent compact mode still emits `turn_preflight_compaction_applied`.
- [ ] Validation auto mode preserves the original exit code and final 50 logical lines.
- [ ] Validation full mode bypasses the fixed line cap.
- [ ] Discovery and unrelated commands are not classified as validation.
- [ ] No new casts, `any`, non-null assertions, namespace imports, dynamic function injection, shims, or compatibility branches exist.
- [ ] No temporary investigation files remain.
- [ ] `git status --short` shows only intended changes plus the user's pre-existing untracked files.
