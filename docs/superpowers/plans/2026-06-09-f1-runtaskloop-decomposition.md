# F1: `runTaskLoop` Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Break the ~1,350-line `runTaskLoop` god-function in `src/repo-search/engine.ts` (lines 888–2234) into small, explicitly-typed, unit-testable classes under `src/repo-search/engine/`, with zero behavior change.

**Architecture:** Strangler-style extraction in three phases. Phase A extracts leaf state-machines (budget math, token accounting, duplicate tracking, forced-finish, stats, transcript, output fitting, read-window governance, terminal synthesis) as standalone classes, each TDD'd in isolation. Phase B swaps each class into `runTaskLoop` one at a time, re-running the existing integration suite (the behavior lock) after every swap. Phase C extracts the turn-preflight block and finally moves the shrunken loop body into a `TaskLoop` orchestrator class; `runTaskLoop` becomes a 2-line wrapper so every existing caller and test keeps working unchanged.

**Tech Stack:** TypeScript (strict), `node:test` + `node:assert/strict`, `tsx` test runner. No new dependencies.

---

## Ground rules for the executor

1. **Zero behavior change.** This is a pure refactor. Every message string, counter increment, log-event shape, and ordering must be byte-identical. When in doubt, copy the existing expression verbatim into the new class.
2. **Behavior lock = the existing integration suite.** After EVERY task, run:

   ```powershell
   npx tsx --test tests/repo-search-loop.core.test.ts tests/mock-repo-search-loop.test.ts tests/repo-search.test.ts tests/repo-search-terminal-synthesis-retry.test.ts tests/repo-search-logging.test.ts tests/tool-command-display.test.ts tests/repo-search-chat-loop.test.ts tests/repo-search-chat-execute.test.ts tests/repo-search-planner-empty-tools.test.ts
   ```

   (referred to below as **LOOP SUITE**; expected: all pass, 0 fail). These tests drive `runTaskLoop` end-to-end via `mockResponses`/`mockCommandResults` and assert on transcripts, stats, and log events — they will catch any drift. The chat tests specifically lock the `loopKind: 'chat'` / `historyMessages` / grounding paths, and the empty-tools test locks `plannerToolDefinitions: []` — paths the repo-search-only tests never reach.
3. **Line numbers** below refer to `src/repo-search/engine.ts` as of commit `cc68b41` (file is 2,409 lines). Re-anchor by searching the quoted code if lines have drifted.
4. **API freeze:** `runTaskLoop`, `runRepoSearch`, `buildScorecard`, `assertConfiguredModelPresent`, `TASK_PACK`, `TaskDefinition`, `TaskResult`, `Scorecard` keep their exact export names/signatures from `src/repo-search/engine.ts` (tests and `src/status-server/chat.ts` import them from there). Internals move; the module's public surface does not.
5. **No dynamic function passing** (repo rule). The single pre-existing exception is `options.onProgress` — Task 9 confines it inside `ProgressReporter` so no other class ever receives a callback.
6. **No worktrees** (repo rule). Branch from `main`: `git checkout main; git pull; git checkout -b refactor/f1-task-loop`.
7. **Typecheck every new test file.** `tsconfig.test.json` has an explicit `include` list; each task that adds a test file must add it there (step included per task). Run `npm run typecheck:test` whenever that file changes.
8. New unit tests import from `../src/...` (NOT `../dist/...`) — same convention as `tests/tool-loop-governor.test.ts`.

## File structure (end state)

| File | Responsibility | New/Existing |
|---|---|---|
| `src/repo-search/engine.ts` | Public surface: `TASK_PACK`, types, `runTaskLoop` (thin wrapper), `buildScorecard`, `assertConfiguredModelPresent`, `runRepoSearch` | shrinks to <450 lines |
| `src/repo-search/engine/abort.ts` | `getAbortError`, `throwIfAborted` | new (moved) |
| `src/repo-search/engine/command-execution.ts` | `findMockResult`, `executeRepoCommand`, `normalizeToolTypeFromCommand` | new (moved) |
| `src/repo-search/engine/native-tools.ts` | `repo_read_file`/`repo_list_files`/`web_*` native execution: `planRepoReadFile`, `buildRepoReadFileExecution`, `executeNativeRepoTool`, `buildNativeRepoToolRequestedCommand`, `buildRepoReadFileCommand`, path/glob helpers, `NativeRepoToolExecution` type | new (moved) |
| `src/repo-search/engine/turn-budget.ts` | `TurnBudget` class: context split, per-tool caps, remaining allowance | new |
| `src/repo-search/engine/token-usage.ts` | `TokenUsageTracker` class: all `model*Tokens` accounting | new |
| `src/repo-search/engine/tool-stats.ts` | `ToolStatsRecorder` class: `toolStatsByType` mutations | new |
| `src/repo-search/engine/duplicate-tracker.ts` | `DuplicateTracker` class: exact/semantic duplicate detection + replay state | new |
| `src/repo-search/engine/forced-finish.ts` | `ForcedFinishController` class: zero-output streak + forced-finish attempts | new |
| `src/repo-search/engine/progress-reporter.ts` | `ProgressReporter` class: sole owner of `onProgress` | new |
| `src/repo-search/engine/transcript-manager.ts` | `TranscriptManager` class: owns `messages[]` + log-cursor | new |
| `src/repo-search/engine/tool-result-budgeter.ts` | `ToolResultBudgeter` class: token counting + `ToolOutputFitter` fitting + budget-rejection text | new |
| `src/repo-search/engine/read-window-governor.ts` | `ReadWindowGovernor` class: owns `fileReadCountByPath`/`fileReadStateByPath`, window adjustment + overlap metrics | new |
| `src/repo-search/engine/terminal-synthesizer.ts` | `TerminalSynthesizer` class: 3-attempt synthesis fallback | new |
| `src/repo-search/engine/prompt-preparer.ts` | `PromptPreparer` class: per-turn render→preflight→compaction→overflow | new |
| `src/repo-search/engine/task-loop.ts` | `TaskLoop` orchestrator class | new |
| `tests/engine-*.test.ts` (one per class, named below) | unit tests | new |

Existing collaborators (unchanged): `planner-protocol.ts`, `prompt-budget.ts`, `command-safety.ts`, `engine/read-overlap.ts`, `../tool-loop-governor.ts`, `../tool-call-messages.ts`, `../tool-output-fit.ts`, `repetition-guard.ts`, `chat-grounding-policy.ts`, `../web-search/web-research-tools.ts`.

---

### Task 1: Baseline

**Files:** none modified.

- [ ] **Step 1: Create branch**

```powershell
git checkout main; if ($?) { git pull }; if ($?) { git checkout -b refactor/f1-task-loop }
```

- [ ] **Step 2: Record the baseline — run LOOP SUITE**

```powershell
npx tsx --test tests/repo-search-loop.core.test.ts tests/mock-repo-search-loop.test.ts tests/repo-search.test.ts tests/repo-search-terminal-synthesis-retry.test.ts tests/repo-search-logging.test.ts tests/tool-command-display.test.ts tests/repo-search-chat-loop.test.ts tests/repo-search-chat-execute.test.ts tests/repo-search-planner-empty-tools.test.ts
```

Expected: `# fail 0`. If anything fails on the clean branch, STOP and report — the lock is broken before we start.

- [ ] **Step 3: Record `engine.ts` size**

```powershell
(Get-Content src\repo-search\engine.ts | Measure-Object -Line).Lines
```

Expected: ~2409. Final task asserts this drops below 450.

---

### Task 2: Move abort + command-execution helpers (pure move)

**Files:**
- Create: `src/repo-search/engine/abort.ts`
- Create: `src/repo-search/engine/command-execution.ts`
- Modify: `src/repo-search/engine.ts` (delete moved code, import instead)
- Test: `tests/engine-command-execution.test.ts`

These are already free functions (engine.ts lines 153–163, 649–738); they move verbatim.

- [ ] **Step 1: Write the failing test**

Create `tests/engine-command-execution.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { getAbortError, throwIfAborted } from '../src/repo-search/engine/abort.js';
import {
  executeRepoCommand,
  findMockResult,
  normalizeToolTypeFromCommand,
} from '../src/repo-search/engine/command-execution.js';

test('getAbortError prefers the abort reason when it is an Error', () => {
  const controller = new AbortController();
  const reason = new Error('custom reason');
  controller.abort(reason);
  assert.equal(getAbortError(controller.signal), reason);
});

test('getAbortError falls back to a default message', () => {
  const controller = new AbortController();
  controller.abort('plain-string');
  assert.equal(getAbortError(controller.signal).message, 'plain-string');
  assert.equal(getAbortError(undefined).message, 'Repo search aborted.');
});

test('throwIfAborted throws only when the signal is aborted', () => {
  const controller = new AbortController();
  throwIfAborted(controller.signal);
  throwIfAborted(undefined);
  controller.abort(new Error('stop'));
  assert.throws(() => throwIfAborted(controller.signal), /stop/u);
});

test('findMockResult prefers exact key, then longest prefix', () => {
  const mocks = {
    'rg -n foo': { exitCode: 0, stdout: 'exact', stderr: '' },
    'rg -n': { exitCode: 0, stdout: 'short-prefix', stderr: '' },
    'rg -n foo --glob': { exitCode: 0, stdout: 'long-prefix', stderr: '' },
  };
  assert.equal(findMockResult('rg -n foo', mocks)?.stdout, 'exact');
  assert.equal(findMockResult('rg -n foo --glob "!dist"', mocks)?.stdout, 'long-prefix');
  assert.equal(findMockResult('git log', mocks), null);
});

test('executeRepoCommand returns mock results and honors delayMs ordering', async () => {
  const result = await executeRepoCommand(
    'rg -n foo',
    process.cwd(),
    { 'rg -n foo': { exitCode: 2, stdout: 'out', stderr: 'err' } },
  );
  assert.deepEqual(result, { exitCode: 2, output: 'outerr' });
});

test('executeRepoCommand rejects when the abort signal fires during a delayed mock', async () => {
  const controller = new AbortController();
  const pending = executeRepoCommand(
    'rg -n foo',
    process.cwd(),
    { 'rg -n foo': { exitCode: 0, stdout: 'late', stderr: '', delayMs: 5000 } },
    controller.signal,
  );
  controller.abort(new Error('aborted-mid-mock'));
  await assert.rejects(pending, /aborted-mid-mock/u);
});

test('normalizeToolTypeFromCommand extracts the command family', () => {
  assert.equal(normalizeToolTypeFromCommand('rg -n "foo" src'), 'rg');
  assert.equal(normalizeToolTypeFromCommand('"C:\\tools\\rg.exe" -n foo'), 'rg.exe');
  assert.equal(normalizeToolTypeFromCommand('   '), 'unknown');
  assert.equal(normalizeToolTypeFromCommand('Get-Content src/a.ts'), 'get-content');
});
```

- [ ] **Step 2: Run it — verify it fails**

```powershell
npx tsx --test tests/engine-command-execution.test.ts
```

Expected: FAIL — `Cannot find module .../engine/abort.js`.

- [ ] **Step 3: Create `src/repo-search/engine/abort.ts`**

Move engine.ts lines 153–163 verbatim, adding `export`:

```ts
export function getAbortError(abortSignal?: AbortSignal): Error {
  return abortSignal?.reason instanceof Error
    ? abortSignal.reason
    : new Error(String(abortSignal?.reason || 'Repo search aborted.'));
}

export function throwIfAborted(abortSignal?: AbortSignal): void {
  if (abortSignal?.aborted) {
    throw getAbortError(abortSignal);
  }
}
```

- [ ] **Step 4: Create `src/repo-search/engine/command-execution.ts`**

Move `findMockResult` (lines 649–665), `executeRepoCommand` (667–722), `normalizeToolTypeFromCommand` (724–738) verbatim, adding `export` to each. Header imports:

```ts
import { spawnDirectCommand } from '../../lib/command-spawn.js';
import { spawnPowerShellAsync } from '../../lib/powershell.js';
import { parseDirectRgCommand } from '../command-safety.js';
import type { RepoSearchMockCommandResult } from '../types.js';
import { getAbortError, throwIfAborted } from './abort.js';
```

(Function bodies are unchanged copies — do not retype them, cut/paste from engine.ts.)

- [ ] **Step 5: Update `engine.ts`**

Delete the three moved functions plus `getAbortError`/`throwIfAborted` from engine.ts. Add imports:

```ts
import { getAbortError, throwIfAborted } from './engine/abort.js';
import { executeRepoCommand, findMockResult, normalizeToolTypeFromCommand } from './engine/command-execution.js';
```

Remove now-unused engine.ts imports `spawnDirectCommand`, `spawnPowerShellAsync`, and `parseDirectRgCommand` (keep `parseDirectRgCommand` only if still referenced — search first; as of cc68b41 it is only used by `executeRepoCommand`).

- [ ] **Step 6: Add test to typecheck + verify**

In `tsconfig.test.json`, append `"tests/engine-command-execution.test.ts"` to `include`. Then:

```powershell
npm run typecheck:test; if ($?) { npx tsx --test tests/engine-command-execution.test.ts }
```

Expected: typecheck clean, 7 tests pass.

- [ ] **Step 7: Run LOOP SUITE** (command in Ground rules §2). Expected: 0 fail.

- [ ] **Step 8: Commit**

```powershell
git add src/repo-search/engine/abort.ts src/repo-search/engine/command-execution.ts src/repo-search/engine.ts tests/engine-command-execution.test.ts tsconfig.test.json
git commit -m "refactor(repo-search): extract abort + command execution helpers from engine.ts"
```

---

### Task 3: Move native-tool execution (pure move)

**Files:**
- Create: `src/repo-search/engine/native-tools.ts`
- Modify: `src/repo-search/engine.ts`
- Test: `tests/engine-native-tools.test.ts`

Moves engine.ts lines 236–647 verbatim: types `NativeRepoToolExecution`, `RepoReadFilePlan`; functions `isFailedRepoReadFilePlan`, `normalizeRepoRelativePathForDisplay`, `isRepoRelativePathIgnored`, `resolveRepoScopedPath`, `globToRegExp`, `matchesRepoListGlob`, `formatNumberedTextBlock`, `buildRepoReadFileCommand`, `buildRepoListFilesCommand`, `buildNativeRepoToolRequestedCommand`, `planRepoReadFile`, `buildRepoReadFileExecution`, `listRepoFilesRecursive`, `executeNativeRepoTool`. Also move the transcript-action helpers that belong to native tools: `parseEffectiveReadFileArgs`, `buildEffectiveTranscriptAction`, `EffectiveTranscriptActionOptions` (lines 287–331).

- [ ] **Step 1: Write the failing test**

Create `tests/engine-native-tools.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildIgnorePolicy } from '../src/repo-search/command-safety.js';
import {
  buildEffectiveTranscriptAction,
  buildNativeRepoToolRequestedCommand,
  buildRepoReadFileCommand,
  executeNativeRepoTool,
  isFailedRepoReadFilePlan,
  planRepoReadFile,
} from '../src/repo-search/engine/native-tools.js';
import { WebResearchTools } from '../src/web-search/web-research-tools.js';

function makeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-native-tools-'));
  fs.writeFileSync(path.join(root, '.gitignore'), 'ignored-dir/\n', 'utf8');
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'ignored-dir'));
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'line1\nline2\nline3\n', 'utf8');
  fs.writeFileSync(path.join(root, 'ignored-dir', 'b.ts'), 'hidden\n', 'utf8');
  return root;
}

function makeWebTools(): WebResearchTools {
  return new WebResearchTools({
    EnabledDefault: false,
    Providers: { tavily: { Enabled: false, ApiKey: '' }, firecrawl: { Enabled: false, ApiKey: '' } },
    ProviderOrder: ['tavily', 'firecrawl'],
    ResultCount: 5, FetchMaxPages: 3, TimeoutMs: 15000, FetchMaxCharacters: 12000,
  });
}

test('buildRepoReadFileCommand clamps bounds and serializes endLine only when positive', () => {
  assert.equal(buildRepoReadFileCommand('src/a.ts', 0), 'repo_read_file path="src/a.ts" startLine=1');
  assert.equal(buildRepoReadFileCommand('src/a.ts', 2, 9), 'repo_read_file path="src/a.ts" startLine=2 endLine=9');
});

test('buildNativeRepoToolRequestedCommand covers all native tools', () => {
  assert.equal(
    buildNativeRepoToolRequestedCommand('repo_read_file', { path: 'src/a.ts', startLine: 1, endLine: 2 }),
    'repo_read_file path="src/a.ts" startLine=1 endLine=2',
  );
  assert.equal(buildNativeRepoToolRequestedCommand('web_search', { query: ' q ' }), 'web_search query="q"');
  assert.equal(buildNativeRepoToolRequestedCommand('web_fetch', { url: 'https://x' }), 'web_fetch url="https://x"');
  assert.equal(
    buildNativeRepoToolRequestedCommand('repo_list_files', { path: 'src', glob: '*.ts' }),
    'repo_list_files path="src" glob="*.ts" recurse=true',
  );
});

test('planRepoReadFile rejects escapes, ignored, and missing paths', () => {
  const root = makeRepo();
  const policy = buildIgnorePolicy(root);
  const escape = planRepoReadFile({ path: '../outside.ts', startLine: 1 }, root, policy);
  assert.ok(isFailedRepoReadFilePlan(escape) && /repository root/u.test(escape.reason));
  const ignored = planRepoReadFile({ path: 'ignored-dir/b.ts', startLine: 1 }, root, policy);
  assert.ok(isFailedRepoReadFilePlan(ignored) && /ignored/u.test(ignored.reason));
  const missing = planRepoReadFile({ path: 'src/nope.ts', startLine: 1 }, root, policy);
  assert.ok(isFailedRepoReadFilePlan(missing) && /readable file/u.test(missing.reason));
});

test('planRepoReadFile returns a numbered window for a valid path', () => {
  const root = makeRepo();
  const plan = planRepoReadFile({ path: 'src/a.ts', startLine: 1, endLine: 2 }, root, buildIgnorePolicy(root));
  assert.ok(!isFailedRepoReadFilePlan(plan));
  assert.equal(plan.displayPath, 'src/a.ts');
  assert.equal(plan.effectiveStartLine, 1);
  assert.equal(plan.effectiveEndLineExclusive, 3);
  assert.equal(plan.hasUnread, true);
});

test('executeNativeRepoTool lists files honoring ignore policy and glob', async () => {
  const root = makeRepo();
  const result = await executeNativeRepoTool(
    'repo_list_files', { path: '.', glob: '*.ts' }, root, buildIgnorePolicy(root), makeWebTools(),
  );
  assert.ok(result.ok);
  assert.equal(result.output, 'src/a.ts');
});

test('buildEffectiveTranscriptAction re-parses executed repo_read_file commands', () => {
  const action = buildEffectiveTranscriptAction({
    toolName: 'repo_read_file',
    rawArgs: { path: 'src/a.ts', startLine: 1, endLine: 99 },
    isNativeTool: true,
    commandToRun: 'repo_read_file path="src/a.ts" startLine=1 endLine=2',
  });
  assert.deepEqual(action, { tool_name: 'repo_read_file', args: { path: 'src/a.ts', startLine: 1, endLine: 2 } });
});
```

- [ ] **Step 2: Run it — verify it fails**

```powershell
npx tsx --test tests/engine-native-tools.test.ts
```

Expected: FAIL — `Cannot find module .../engine/native-tools.js`.

- [ ] **Step 3: Create `src/repo-search/engine/native-tools.ts`**

Cut lines 236–647 (the ranges listed above) from engine.ts and paste verbatim. Add `export` to: `NativeRepoToolExecution`, `RepoReadFilePlan`, `isFailedRepoReadFilePlan`, `buildEffectiveTranscriptAction`, `buildRepoReadFileCommand`, `buildRepoListFilesCommand`, `buildNativeRepoToolRequestedCommand`, `planRepoReadFile`, `buildRepoReadFileExecution`, `executeNativeRepoTool`. Keep the rest module-private. Header imports:

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type IgnorePolicy } from '../command-safety.js';
import { estimateTokenCount } from '../prompt-budget.js';
import { findContiguousUnreadRange, type ToolOutputTruncationUnit } from '../../tool-output-fit.js';
import { getOrCreateFileReadState, type FileReadState } from './read-overlap.js';
import type { ToolTranscriptAction } from '../../tool-call-messages.js';
import { WebResearchTools } from '../../web-search/web-research-tools.js';
import type { WebFetchToolArgs, WebSearchToolArgs } from '../../web-search/types.js';
```

- [ ] **Step 4: Update `engine.ts`**

Add import:

```ts
import {
  buildEffectiveTranscriptAction,
  buildNativeRepoToolRequestedCommand,
  buildRepoReadFileCommand,
  buildRepoReadFileExecution,
  executeNativeRepoTool,
  isFailedRepoReadFilePlan,
  planRepoReadFile,
  type NativeRepoToolExecution,
} from './engine/native-tools.js';
```

Delete the moved code. Remove engine.ts imports that became unused (`fs`, `path` — verify with `npm run typecheck:test`; `formatNumberedTextBlock` etc. are gone with the move).

- [ ] **Step 5: Add `"tests/engine-native-tools.test.ts"` to `tsconfig.test.json` include; typecheck + run unit test**

```powershell
npm run typecheck:test; if ($?) { npx tsx --test tests/engine-native-tools.test.ts }
```

Expected: PASS (6 tests).

- [ ] **Step 6: Run LOOP SUITE.** Expected: 0 fail.

- [ ] **Step 7: Commit**

```powershell
git add -A src tests tsconfig.test.json
git commit -m "refactor(repo-search): extract native repo tool execution into engine/native-tools.ts"
```

---

### Task 4: `TurnBudget` class

**Files:**
- Create: `src/repo-search/engine/turn-budget.ts`
- Test: `tests/engine-turn-budget.test.ts`

Captures the budget math currently at engine.ts lines 913–915 (`thinkingBufferTokens`, `usablePromptTokens`), 1648–1649 / 1861–1862 (per-tool cap), and 1863–1866 (remaining allowance). Constants `THINKING_BUFFER_RATIO`, `THINKING_BUFFER_MIN_TOKENS`, `PER_TOOL_RESULT_RATIO` move here (delete from engine.ts in Task 14).

- [ ] **Step 1: Write the failing test**

Create `tests/engine-turn-budget.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PER_TOOL_RESULT_RATIO,
  THINKING_BUFFER_MIN_TOKENS,
  THINKING_BUFFER_RATIO,
  TurnBudget,
} from '../src/repo-search/engine/turn-budget.js';

test('TurnBudget splits context into thinking buffer and usable prompt tokens', () => {
  const budget = new TurnBudget({ totalContextTokens: 100_000, maxTurns: 45 });
  assert.equal(budget.thinkingBufferTokens, Math.max(Math.ceil(100_000 * THINKING_BUFFER_RATIO), THINKING_BUFFER_MIN_TOKENS));
  assert.equal(budget.usablePromptTokens, 100_000 - budget.thinkingBufferTokens);
});

test('TurnBudget enforces the 4000-token minimum thinking buffer on small contexts', () => {
  const budget = new TurnBudget({ totalContextTokens: 8_000, maxTurns: 45 });
  assert.equal(budget.thinkingBufferTokens, 4_000);
  assert.equal(budget.usablePromptTokens, 4_000);
});

test('usablePromptTokens never goes negative', () => {
  const budget = new TurnBudget({ totalContextTokens: 1_000, maxTurns: 45 });
  assert.equal(budget.usablePromptTokens, 0);
});

test('perToolCapTokens uses the floor ratio until command count overtakes it', () => {
  const budget = new TurnBudget({ totalContextTokens: 100_000, maxTurns: 10 });
  assert.equal(budget.perToolCapTokens(0), Math.max(1, Math.floor(budget.usablePromptTokens * PER_TOOL_RESULT_RATIO)));
  assert.equal(budget.perToolCapTokens(5), Math.max(1, Math.floor(budget.usablePromptTokens * 0.5)));
});

test('remainingToolAllowance subtracts prompt and accepted tool tokens, clamped at zero', () => {
  const budget = new TurnBudget({ totalContextTokens: 100_000, maxTurns: 45 });
  assert.equal(budget.remainingToolAllowance(10_000, 5_000), budget.usablePromptTokens - 15_000);
  assert.equal(budget.remainingToolAllowance(budget.usablePromptTokens, 1), 0);
});
```

- [ ] **Step 2: Run it — verify it fails**

```powershell
npx tsx --test tests/engine-turn-budget.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/repo-search/engine/turn-budget.ts`**

```ts
export const THINKING_BUFFER_RATIO = 0.15;
export const THINKING_BUFFER_MIN_TOKENS = 4000;
export const PER_TOOL_RESULT_RATIO = 0.10;

export class TurnBudget {
  readonly totalContextTokens: number;
  readonly thinkingBufferTokens: number;
  readonly usablePromptTokens: number;
  private readonly maxTurns: number;

  constructor(options: { totalContextTokens: number; maxTurns: number }) {
    this.totalContextTokens = Math.max(1, options.totalContextTokens);
    this.maxTurns = Math.max(1, options.maxTurns);
    this.thinkingBufferTokens = Math.max(
      Math.ceil(this.totalContextTokens * THINKING_BUFFER_RATIO),
      THINKING_BUFFER_MIN_TOKENS,
    );
    this.usablePromptTokens = Math.max(this.totalContextTokens - this.thinkingBufferTokens, 0);
  }

  perToolCapTokens(commandCount: number): number {
    const dynamicRatio = Math.max(PER_TOOL_RESULT_RATIO, commandCount / this.maxTurns);
    return Math.max(1, Math.floor(this.usablePromptTokens * dynamicRatio));
  }

  remainingToolAllowance(promptTokenCount: number, acceptedToolPromptTokensThisTurn: number): number {
    return Math.max(this.usablePromptTokens - promptTokenCount - acceptedToolPromptTokensThisTurn, 0);
  }
}
```

- [ ] **Step 4: Add `"tests/engine-turn-budget.test.ts"` to `tsconfig.test.json`; verify**

```powershell
npm run typecheck:test; if ($?) { npx tsx --test tests/engine-turn-budget.test.ts }
```

Expected: PASS (5 tests). LOOP SUITE not needed (engine.ts untouched).

- [ ] **Step 5: Commit**

```powershell
git add src/repo-search/engine/turn-budget.ts tests/engine-turn-budget.test.ts tsconfig.test.json
git commit -m "feat(repo-search): add TurnBudget class for task-loop token budgeting"
```

---

### Task 5: `TokenUsageTracker` class

**Files:**
- Create: `src/repo-search/engine/token-usage.ts`
- Test: `tests/engine-token-usage.test.ts`

Captures the eight `model*` accumulators (engine.ts lines 903–910) and the `Number.isFinite` guard blocks at 1273–1284 (planner response) and 2172–2184 (synthesis response). Note the existing behavior: `outputTokens` are NOT added inside the guard block — callers add the resolved completion tokens only on parse-failure, finish, and synthesis paths. The tracker therefore *returns* the resolved values and exposes `addOutputTokens`.

- [ ] **Step 1: Write the failing test**

Create `tests/engine-token-usage.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { TokenUsageTracker } from '../src/repo-search/engine/token-usage.js';

test('recordModelResponse accumulates usage fields and returns resolved counts', () => {
  const tracker = new TokenUsageTracker(undefined);
  const resolved = tracker.recordModelResponse({
    text: 'hello', thinkingText: 'thought',
    promptTokens: 100, completionTokens: 20, usageThinkingTokens: 7,
    promptCacheTokens: 50, promptEvalTokens: 60,
    promptEvalDurationMs: 11, generationDurationMs: 22,
  });
  assert.deepEqual(resolved, { completionTokens: 20, thinkingTokens: 7 });
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.promptTokens, 100);
  assert.equal(snapshot.thinkingTokens, 7);
  assert.equal(snapshot.promptCacheTokens, 50);
  assert.equal(snapshot.promptEvalTokens, 60);
  assert.equal(snapshot.promptEvalDurationMs, 11);
  assert.equal(snapshot.generationDurationMs, 22);
  assert.equal(snapshot.outputTokens, 0); // caller decides when completion tokens count as output
});

test('recordModelResponse estimates completion/thinking tokens when usage is missing', () => {
  const tracker = new TokenUsageTracker(undefined);
  const resolved = tracker.recordModelResponse({ text: 'some response text', thinkingText: 'some thinking' });
  assert.ok(resolved.completionTokens > 0);
  assert.ok(resolved.thinkingTokens > 0);
  const empty = tracker.recordModelResponse({ text: '', thinkingText: '' });
  assert.deepEqual(empty, { completionTokens: 0, thinkingTokens: 0 });
});

test('negative or non-finite usage fields are ignored', () => {
  const tracker = new TokenUsageTracker(undefined);
  tracker.recordModelResponse({ text: '', promptTokens: -5, promptCacheTokens: Number.NaN });
  assert.equal(tracker.snapshot().promptTokens, 0);
  assert.equal(tracker.snapshot().promptCacheTokens, 0);
});

test('addOutputTokens and addToolTokens accumulate; tool tokens are ceiled and floored at zero', () => {
  const tracker = new TokenUsageTracker(undefined);
  tracker.addOutputTokens(15);
  tracker.addToolTokens(3.2);
  tracker.addToolTokens(-1);
  assert.equal(tracker.snapshot().outputTokens, 15);
  assert.equal(tracker.snapshot().toolTokens, 4);
});
```

- [ ] **Step 2: Run it — verify it fails**

```powershell
npx tsx --test tests/engine-token-usage.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/repo-search/engine/token-usage.ts`**

```ts
import type { SiftConfig } from '../../config/index.js';
import { estimateTokenCount } from '../prompt-budget.js';

export type ModelUsageResponse = {
  text?: string;
  thinkingText?: string;
  promptTokens?: number;
  completionTokens?: number;
  usageThinkingTokens?: number;
  promptCacheTokens?: number;
  promptEvalTokens?: number;
  promptEvalDurationMs?: number;
  generationDurationMs?: number;
};

export type ResolvedResponseTokens = {
  completionTokens: number;
  thinkingTokens: number;
};

export type TokenUsageSnapshot = {
  promptTokens: number;
  outputTokens: number;
  toolTokens: number;
  thinkingTokens: number;
  promptCacheTokens: number;
  promptEvalTokens: number;
  promptEvalDurationMs: number;
  generationDurationMs: number;
};

export class TokenUsageTracker {
  private promptTokens = 0;
  private outputTokens = 0;
  private toolTokens = 0;
  private thinkingTokens = 0;
  private promptCacheTokens = 0;
  private promptEvalTokens = 0;
  private promptEvalDurationMs = 0;
  private generationDurationMs = 0;
  private readonly config: SiftConfig | undefined;

  constructor(config: SiftConfig | undefined) {
    this.config = config;
  }

  recordModelResponse(response: ModelUsageResponse): ResolvedResponseTokens {
    if (Number.isFinite(response.promptTokens) && Number(response.promptTokens) >= 0) {
      this.promptTokens += Number(response.promptTokens);
    }
    const completionTokens = Number.isFinite(response.completionTokens) && Number(response.completionTokens) >= 0
      ? Number(response.completionTokens)
      : (String(response.text || '').trim() ? estimateTokenCount(this.config, String(response.text || '')) : 0);
    const thinkingTokens = Number.isFinite(response.usageThinkingTokens) && Number(response.usageThinkingTokens) >= 0
      ? Number(response.usageThinkingTokens)
      : (String(response.thinkingText || '').trim() ? estimateTokenCount(this.config, String(response.thinkingText || '')) : 0);
    this.thinkingTokens += thinkingTokens;
    if (Number.isFinite(response.promptCacheTokens) && Number(response.promptCacheTokens) >= 0) {
      this.promptCacheTokens += Number(response.promptCacheTokens);
    }
    if (Number.isFinite(response.promptEvalTokens) && Number(response.promptEvalTokens) >= 0) {
      this.promptEvalTokens += Number(response.promptEvalTokens);
    }
    if (Number.isFinite(response.promptEvalDurationMs) && Number(response.promptEvalDurationMs) >= 0) {
      this.promptEvalDurationMs += Number(response.promptEvalDurationMs);
    }
    if (Number.isFinite(response.generationDurationMs) && Number(response.generationDurationMs) >= 0) {
      this.generationDurationMs += Number(response.generationDurationMs);
    }
    return { completionTokens, thinkingTokens };
  }

  addOutputTokens(tokens: number): void {
    this.outputTokens += tokens;
  }

  addToolTokens(tokens: number): void {
    this.toolTokens += Math.max(0, Math.ceil(tokens));
  }

  snapshot(): TokenUsageSnapshot {
    return {
      promptTokens: this.promptTokens,
      outputTokens: this.outputTokens,
      toolTokens: this.toolTokens,
      thinkingTokens: this.thinkingTokens,
      promptCacheTokens: this.promptCacheTokens,
      promptEvalTokens: this.promptEvalTokens,
      promptEvalDurationMs: this.promptEvalDurationMs,
      generationDurationMs: this.generationDurationMs,
    };
  }
}
```

- [ ] **Step 4: Add `"tests/engine-token-usage.test.ts"` to `tsconfig.test.json`; verify**

```powershell
npm run typecheck:test; if ($?) { npx tsx --test tests/engine-token-usage.test.ts }
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```powershell
git add src/repo-search/engine/token-usage.ts tests/engine-token-usage.test.ts tsconfig.test.json
git commit -m "feat(repo-search): add TokenUsageTracker class"
```

---

### Task 6: `ToolStatsRecorder` class

**Files:**
- Create: `src/repo-search/engine/tool-stats.ts`
- Test: `tests/engine-tool-stats.test.ts`

Captures every `toolStatsByType` mutation: finish rejection (engine.ts 1338–1341 and 1350–1354), semantic-repeat reject (1557–1562), forced-finish-from-stagnation (1575–1578), the main per-call merge (1985–1997), and novelty counters (2004–2008).

- [ ] **Step 1: Write the failing test**

Create `tests/engine-tool-stats.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { ToolStatsRecorder } from '../src/repo-search/engine/tool-stats.js';

test('recordFinishRejection increments loop.finishRejections from empty stats', () => {
  const recorder = new ToolStatsRecorder();
  recorder.recordFinishRejection();
  recorder.recordFinishRejection();
  assert.equal(recorder.snapshot().loop.finishRejections, 2);
});

test('recordToolCall merges counters exactly like the inline engine block', () => {
  const recorder = new ToolStatsRecorder();
  recorder.recordToolCall({
    toolType: 'rg',
    resultTextLength: 120,
    resultTokenCount: 30.4,
    resultTokenCountEstimated: true,
    rawResultTokenCount: 99.1,
    lineReadStats: { lineReadCalls: 1, lineReadLinesTotal: 50, lineReadTokensTotal: 400 },
  });
  const stats = recorder.snapshot().rg;
  assert.equal(stats.calls, 1);
  assert.equal(stats.outputCharsTotal, 120);
  assert.equal(stats.outputTokensTotal, 31);
  assert.equal(stats.outputTokensEstimatedCount, 1);
  assert.equal(stats.lineReadCalls, 1);
  assert.equal(stats.lineReadLinesTotal, 50);
  assert.equal(stats.lineReadTokensTotal, 400);
  assert.equal(stats.promptInsertedTokens, 31);
  assert.equal(stats.rawToolResultTokens, 100);
});

test('recordToolCall tolerates null lineReadStats', () => {
  const recorder = new ToolStatsRecorder();
  recorder.recordToolCall({
    toolType: 'rg', resultTextLength: 1, resultTokenCount: 1,
    resultTokenCountEstimated: false, rawResultTokenCount: 1, lineReadStats: null,
  });
  assert.equal(recorder.snapshot().rg.lineReadCalls, 0);
  assert.equal(recorder.snapshot().rg.outputTokensEstimatedCount, 0);
});

test('recordNovelty splits new vs no-new evidence calls', () => {
  const recorder = new ToolStatsRecorder();
  recorder.recordNovelty('rg', true);
  recorder.recordNovelty('rg', false);
  recorder.recordNovelty('rg', false);
  assert.equal(recorder.snapshot().rg.newEvidenceCalls, 1);
  assert.equal(recorder.snapshot().rg.noNewEvidenceCalls, 2);
});

test('semantic repeat and forced-finish counters accumulate per tool type', () => {
  const recorder = new ToolStatsRecorder();
  recorder.recordSemanticRepeatReject('rg');
  recorder.recordForcedFinishFromStagnation('rg');
  recorder.recordForcedFinishFromStagnation('rg');
  assert.equal(recorder.snapshot().rg.semanticRepeatRejects, 1);
  assert.equal(recorder.snapshot().rg.forcedFinishFromStagnation, 2);
});

test('get returns null for unknown tool types and snapshot is a copy', () => {
  const recorder = new ToolStatsRecorder();
  assert.equal(recorder.get('nope'), null);
  const first = recorder.snapshot();
  recorder.recordFinishRejection();
  assert.equal(Object.keys(first).length, 0);
});
```

- [ ] **Step 2: Run it — verify it fails**

```powershell
npx tsx --test tests/engine-tool-stats.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/repo-search/engine/tool-stats.ts`**

```ts
import { createEmptyToolTypeStats } from '../../line-read-guidance.js';
import type { ToolTypeStats } from '../../status-server/metrics.js';

export type ToolCallStatsInput = {
  toolType: string;
  resultTextLength: number;
  resultTokenCount: number;
  resultTokenCountEstimated: boolean;
  rawResultTokenCount: number;
  lineReadStats: {
    lineReadCalls: number;
    lineReadLinesTotal: number;
    lineReadTokensTotal: number;
  } | null;
};

export class ToolStatsRecorder {
  private readonly statsByType: Record<string, ToolTypeStats> = {};

  private current(toolType: string): ToolTypeStats {
    return this.statsByType[toolType] || createEmptyToolTypeStats();
  }

  recordFinishRejection(): void {
    const stats = this.current('loop');
    this.statsByType.loop = { ...stats, finishRejections: stats.finishRejections + 1 };
  }

  recordSemanticRepeatReject(toolType: string): void {
    const stats = this.current(toolType);
    this.statsByType[toolType] = { ...stats, semanticRepeatRejects: stats.semanticRepeatRejects + 1 };
  }

  recordForcedFinishFromStagnation(toolType: string): void {
    const stats = this.current(toolType);
    this.statsByType[toolType] = {
      ...stats,
      forcedFinishFromStagnation: Number(stats.forcedFinishFromStagnation || 0) + 1,
    };
  }

  recordToolCall(input: ToolCallStatsInput): void {
    const stats = this.current(input.toolType);
    this.statsByType[input.toolType] = {
      ...stats,
      calls: stats.calls + 1,
      outputCharsTotal: stats.outputCharsTotal + input.resultTextLength,
      outputTokensTotal: stats.outputTokensTotal + Math.max(0, Math.ceil(input.resultTokenCount)),
      outputTokensEstimatedCount: stats.outputTokensEstimatedCount + (input.resultTokenCountEstimated ? 1 : 0),
      lineReadCalls: stats.lineReadCalls + Number(input.lineReadStats?.lineReadCalls || 0),
      lineReadLinesTotal: stats.lineReadLinesTotal + Number(input.lineReadStats?.lineReadLinesTotal || 0),
      lineReadTokensTotal: stats.lineReadTokensTotal + Number(input.lineReadStats?.lineReadTokensTotal || 0),
      promptInsertedTokens: stats.promptInsertedTokens + Math.max(0, Math.ceil(input.resultTokenCount)),
      rawToolResultTokens: stats.rawToolResultTokens + Math.max(0, Math.ceil(input.rawResultTokenCount)),
    };
  }

  recordNovelty(toolType: string, hasNewEvidence: boolean): void {
    const stats = this.current(toolType);
    this.statsByType[toolType] = {
      ...stats,
      newEvidenceCalls: stats.newEvidenceCalls + (hasNewEvidence ? 1 : 0),
      noNewEvidenceCalls: stats.noNewEvidenceCalls + (hasNewEvidence ? 0 : 1),
    };
  }

  get(toolType: string): ToolTypeStats | null {
    return this.statsByType[toolType] || null;
  }

  snapshot(): Record<string, ToolTypeStats> {
    return { ...this.statsByType };
  }
}
```

- [ ] **Step 4: Add `"tests/engine-tool-stats.test.ts"` to `tsconfig.test.json`; verify**

```powershell
npm run typecheck:test; if ($?) { npx tsx --test tests/engine-tool-stats.test.ts }
```

Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```powershell
git add src/repo-search/engine/tool-stats.ts tests/engine-tool-stats.test.ts tsconfig.test.json
git commit -m "feat(repo-search): add ToolStatsRecorder class"
```

---

### Task 7: `DuplicateTracker` class

**Files:**
- Create: `src/repo-search/engine/duplicate-tracker.ts`
- Test: `tests/engine-duplicate-tracker.test.ts`

Captures duplicate state (engine.ts 959–963), classification (1497–1499), replay-count logic (1527–1531), reset-on-success (2070–2077), and the `DUPLICATE_FORCE_THRESHOLD` trigger (1572).

- [ ] **Step 1: Write the failing test**

Create `tests/engine-duplicate-tracker.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { DUPLICATE_FORCE_THRESHOLD, DuplicateTracker } from '../src/repo-search/engine/duplicate-tracker.js';

test('classify flags exact duplicates of the last successful normalized key', () => {
  const tracker = new DuplicateTracker();
  tracker.recordSuccess('rg -n foo', 'fp-1');
  const result = tracker.classify({ toolName: 'run_repo_cmd', normalizedKey: 'rg -n foo', fingerprint: 'fp-2', rejected: false });
  assert.equal(result.isExactDuplicate, true);
  assert.equal(result.isSemanticDuplicate, false);
});

test('classify flags semantic duplicates by fingerprint, not for rejected commands', () => {
  const tracker = new DuplicateTracker();
  tracker.recordSuccess('rg -n foo', 'fp-1');
  const semantic = tracker.classify({ toolName: 'run_repo_cmd', normalizedKey: 'rg -n foo --glob "!x"', fingerprint: 'fp-1', rejected: false });
  assert.equal(semantic.isSemanticDuplicate, true);
  const rejected = tracker.classify({ toolName: 'run_repo_cmd', normalizedKey: 'rg -n foo --glob "!x"', fingerprint: 'fp-1', rejected: true });
  assert.equal(rejected.isSemanticDuplicate, false);
});

test('classify falls back to toolName|normalizedKey when fingerprint is empty', () => {
  const tracker = new DuplicateTracker();
  const result = tracker.classify({ toolName: 'run_repo_cmd', normalizedKey: 'bad cmd', fingerprint: '', rejected: true });
  assert.equal(result.duplicateFingerprint, 'run_repo_cmd|bad cmd');
});

test('registerDuplicate starts at 2 and increments only while the replay message is live', () => {
  const tracker = new DuplicateTracker();
  const first = tracker.registerDuplicate('fp-1', 10);
  assert.equal(first.count, 2);
  assert.equal(first.activeReplayMessageIndex, null);
  tracker.setReplayToolMessageIndex(4);
  const second = tracker.registerDuplicate('fp-1', 10);
  assert.equal(second.count, 3);
  assert.equal(second.activeReplayMessageIndex, 4);
  // index beyond message count -> treated as fresh
  const stale = tracker.registerDuplicate('fp-1', 3);
  assert.equal(stale.count, 2);
  assert.equal(stale.activeReplayMessageIndex, null);
});

test('shouldForceFinish fires at DUPLICATE_FORCE_THRESHOLD and recordSuccess resets everything', () => {
  const tracker = new DuplicateTracker();
  tracker.setReplayToolMessageIndex(1);
  for (let i = 0; i < DUPLICATE_FORCE_THRESHOLD - 1; i += 1) {
    tracker.registerDuplicate('fp-1', 10);
    tracker.setReplayToolMessageIndex(1);
  }
  assert.equal(tracker.shouldForceFinish(), true);
  tracker.recordSuccess('new key', 'fp-9');
  assert.equal(tracker.shouldForceFinish(), false);
  assert.equal(tracker.registerDuplicate('fp-1', 10).count, 2);
});
```

- [ ] **Step 2: Run it — verify it fails**

```powershell
npx tsx --test tests/engine-duplicate-tracker.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/repo-search/engine/duplicate-tracker.ts`**

```ts
export const DUPLICATE_FORCE_THRESHOLD = 5;

export type DuplicateClassification = {
  isExactDuplicate: boolean;
  isSemanticDuplicate: boolean;
  duplicateFingerprint: string;
};

export type DuplicateRegistration = {
  count: number;
  activeReplayMessageIndex: number | null;
};

export class DuplicateTracker {
  private lastSuccessfulNormalizedKey: string | null = null;
  private lastSuccessfulFingerprint: string | null = null;
  private replayFingerprint: string | null = null;
  private replayCount = 0;
  private replayToolMessageIndex = -1;

  classify(options: {
    toolName: string;
    normalizedKey: string;
    fingerprint: string;
    rejected: boolean;
  }): DuplicateClassification {
    const isExactDuplicate = Boolean(
      this.lastSuccessfulNormalizedKey && options.normalizedKey === this.lastSuccessfulNormalizedKey,
    );
    const isSemanticDuplicate = Boolean(
      !isExactDuplicate
      && !options.rejected
      && options.fingerprint
      && this.lastSuccessfulFingerprint
      && options.fingerprint === this.lastSuccessfulFingerprint,
    );
    return {
      isExactDuplicate,
      isSemanticDuplicate,
      duplicateFingerprint: options.fingerprint || `${options.toolName}|${options.normalizedKey}`,
    };
  }

  registerDuplicate(duplicateFingerprint: string, messageCount: number): DuplicateRegistration {
    const isActiveReplay = this.replayFingerprint === duplicateFingerprint
      && this.replayToolMessageIndex >= 0
      && this.replayToolMessageIndex < messageCount;
    this.replayFingerprint = duplicateFingerprint;
    this.replayCount = isActiveReplay ? this.replayCount + 1 : 2;
    return {
      count: this.replayCount,
      activeReplayMessageIndex: isActiveReplay ? this.replayToolMessageIndex : null,
    };
  }

  setReplayToolMessageIndex(index: number): void {
    this.replayToolMessageIndex = index;
  }

  shouldForceFinish(): boolean {
    return this.replayCount >= DUPLICATE_FORCE_THRESHOLD;
  }

  recordSuccess(normalizedKey: string, fingerprint: string | null): void {
    this.replayFingerprint = null;
    this.replayCount = 0;
    this.replayToolMessageIndex = -1;
    this.lastSuccessfulNormalizedKey = normalizedKey;
    this.lastSuccessfulFingerprint = fingerprint;
  }
}
```

- [ ] **Step 4: Add `"tests/engine-duplicate-tracker.test.ts"` to `tsconfig.test.json`; verify**

```powershell
npm run typecheck:test; if ($?) { npx tsx --test tests/engine-duplicate-tracker.test.ts }
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```powershell
git add src/repo-search/engine/duplicate-tracker.ts tests/engine-duplicate-tracker.test.ts tsconfig.test.json
git commit -m "feat(repo-search): add DuplicateTracker class"
```

---

### Task 8: `ForcedFinishController` class

**Files:**
- Create: `src/repo-search/engine/forced-finish.ts`
- Test: `tests/engine-forced-finish.test.ts`

Captures `zeroOutputStreak`/`forcedFinishAttemptsRemaining` (engine.ts 941–942), attempt consumption (1457–1473), zero-output countdown (1806–1825), and stagnation activation (1572–1574, 1816–1818). Constants `ZERO_OUTPUT_FORCE_THRESHOLD` and `FORCED_FINISH_MAX_ATTEMPTS` move here.

- [ ] **Step 1: Write the failing test**

Create `tests/engine-forced-finish.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FORCED_FINISH_MAX_ATTEMPTS,
  FORCED_FINISH_MODE_MESSAGE,
  ForcedFinishController,
  ZERO_OUTPUT_FORCE_THRESHOLD,
} from '../src/repo-search/engine/forced-finish.js';

test('activateFromStagnation arms the controller and returns the mode-change message', () => {
  const controller = new ForcedFinishController();
  assert.equal(controller.isActive(), false);
  assert.equal(controller.activateFromStagnation(), FORCED_FINISH_MODE_MESSAGE);
  assert.equal(controller.isActive(), true);
});

test('consumeAttempt counts down with exact engine message strings and reports exhaustion', () => {
  const controller = new ForcedFinishController();
  controller.activateFromStagnation();
  const first = controller.consumeAttempt();
  assert.equal(first.attemptsRemaining, FORCED_FINISH_MAX_ATTEMPTS - 1);
  assert.equal(first.rejectionReason, `Forced finish mode active. Return a finish action now. Attempts remaining: ${FORCED_FINISH_MAX_ATTEMPTS - 1}.`);
  assert.equal(first.countdownText, `Forced finish attempts remaining: ${FORCED_FINISH_MAX_ATTEMPTS - 1}. Return a finish action now.`);
  assert.equal(first.exhausted, false);
  controller.consumeAttempt();
  const last = controller.consumeAttempt();
  assert.equal(last.attemptsRemaining, 0);
  assert.equal(last.exhausted, true);
});

test('recordToolOutput counts a zero-output streak with engine warning text', () => {
  const controller = new ForcedFinishController();
  const first = controller.recordToolOutput(0);
  assert.equal(first.zeroOutputStreak, 1);
  assert.equal(first.remainingBeforeForce, ZERO_OUTPUT_FORCE_THRESHOLD - 1);
  assert.equal(first.warningText, `Zero-output warning: ${ZERO_OUTPUT_FORCE_THRESHOLD - 1} more zero-output command(s) and you will be forced to answer.`);
  assert.equal(first.activated, false);
});

test('recordToolOutput resets the streak on non-empty output', () => {
  const controller = new ForcedFinishController();
  controller.recordToolOutput(0);
  const reset = controller.recordToolOutput(42);
  assert.equal(reset.zeroOutputStreak, 0);
  assert.equal(reset.warningText, '');
  assert.equal(controller.recordToolOutput(0).zeroOutputStreak, 1);
});

test('recordToolOutput activates forced finish at the threshold, once', () => {
  const controller = new ForcedFinishController();
  let last = controller.recordToolOutput(0);
  for (let i = 1; i < ZERO_OUTPUT_FORCE_THRESHOLD; i += 1) {
    last = controller.recordToolOutput(0);
  }
  assert.equal(last.remainingBeforeForce, 0);
  assert.equal(last.warningText, `Zero-output limit reached: you are now forced to answer within ${FORCED_FINISH_MAX_ATTEMPTS} attempt(s).`);
  assert.equal(last.activated, true);
  assert.equal(controller.isActive(), true);
  // already active -> not re-activated
  assert.equal(controller.recordToolOutput(0).activated, false);
});
```

- [ ] **Step 2: Run it — verify it fails**

```powershell
npx tsx --test tests/engine-forced-finish.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/repo-search/engine/forced-finish.ts`**

```ts
export const ZERO_OUTPUT_FORCE_THRESHOLD = 10;
export const FORCED_FINISH_MAX_ATTEMPTS = 3;
export const FORCED_FINISH_MODE_MESSAGE = 'Forced finish mode active. Return {"action":"finish",...} now. Tool calls are blocked.';

export type ForcedFinishAttempt = {
  attemptsRemaining: number;
  rejectionReason: string;
  countdownText: string;
  exhausted: boolean;
};

export type ZeroOutputObservation = {
  zeroOutputStreak: number;
  remainingBeforeForce: number;
  warningText: string;
  activated: boolean;
};

export class ForcedFinishController {
  private zeroOutputStreak = 0;
  private attemptsRemaining = 0;

  isActive(): boolean {
    return this.attemptsRemaining > 0;
  }

  activateFromStagnation(): string {
    this.attemptsRemaining = FORCED_FINISH_MAX_ATTEMPTS;
    return FORCED_FINISH_MODE_MESSAGE;
  }

  consumeAttempt(): ForcedFinishAttempt {
    this.attemptsRemaining = Math.max(this.attemptsRemaining - 1, 0);
    return {
      attemptsRemaining: this.attemptsRemaining,
      rejectionReason: `Forced finish mode active. Return a finish action now. Attempts remaining: ${this.attemptsRemaining}.`,
      countdownText: `Forced finish attempts remaining: ${this.attemptsRemaining}. Return a finish action now.`,
      exhausted: this.attemptsRemaining === 0,
    };
  }

  recordToolOutput(baseOutputLength: number): ZeroOutputObservation {
    if (baseOutputLength === 0) {
      this.zeroOutputStreak += 1;
      const remainingBeforeForce = Math.max(ZERO_OUTPUT_FORCE_THRESHOLD - this.zeroOutputStreak, 0);
      const warningText = remainingBeforeForce > 0
        ? `Zero-output warning: ${remainingBeforeForce} more zero-output command(s) and you will be forced to answer.`
        : `Zero-output limit reached: you are now forced to answer within ${FORCED_FINISH_MAX_ATTEMPTS} attempt(s).`;
      const activated = remainingBeforeForce === 0 && this.attemptsRemaining === 0;
      if (activated) {
        this.attemptsRemaining = FORCED_FINISH_MAX_ATTEMPTS;
      }
      return { zeroOutputStreak: this.zeroOutputStreak, remainingBeforeForce, warningText, activated };
    }
    this.zeroOutputStreak = 0;
    return { zeroOutputStreak: 0, remainingBeforeForce: ZERO_OUTPUT_FORCE_THRESHOLD, warningText: '', activated: false };
  }
}
```

- [ ] **Step 4: Add `"tests/engine-forced-finish.test.ts"` to `tsconfig.test.json`; verify**

```powershell
npm run typecheck:test; if ($?) { npx tsx --test tests/engine-forced-finish.test.ts }
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```powershell
git add src/repo-search/engine/forced-finish.ts tests/engine-forced-finish.test.ts tsconfig.test.json
git commit -m "feat(repo-search): add ForcedFinishController class"
```

---

### Task 9: `ProgressReporter` class

**Files:**
- Create: `src/repo-search/engine/progress-reporter.ts`
- Test: `tests/engine-progress-reporter.test.ts`

Confines `options.onProgress` to one class with one explicit method per event kind, replacing ~20 inline `options.onProgress?.({ kind: ... })` blocks (engine.ts 1020–1078, 1122–1152, 1197–1252, 1325–1327, 1366–1368, 1723–1725, 2019–2033, 2163–2191). `model_inventory_*` events stay inline in `runRepoSearch` (no task scope). Every method is a no-op when no callback was provided.

- [ ] **Step 1: Write the failing test**

Create `tests/engine-progress-reporter.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { ProgressReporter } from '../src/repo-search/engine/progress-reporter.js';
import type { RepoSearchProgressEvent } from '../src/repo-search/types.js';

function collect(): { events: RepoSearchProgressEvent[]; reporter: ProgressReporter } {
  const events: RepoSearchProgressEvent[] = [];
  const reporter = new ProgressReporter({
    onProgress: (event) => { events.push(event); },
    taskId: 't1',
    maxTurns: 45,
    taskStartedAt: Date.now(),
  });
  return { events, reporter };
}

test('enabled reflects callback presence; disabled reporter emits nothing', () => {
  const disabled = new ProgressReporter({ onProgress: null, taskId: 't1', maxTurns: 45, taskStartedAt: Date.now() });
  assert.equal(disabled.enabled, false);
  disabled.llmStart(1, 100);
  disabled.thinking(1, 'x');
  const { reporter } = collect();
  assert.equal(reporter.enabled, true);
});

test('preflightStart/preflightDone/llmStart/llmEnd carry task fields and elapsedMs', () => {
  const { events, reporter } = collect();
  reporter.preflightStart(2, 1234);
  reporter.preflightDone(2, 1234, 567);
  reporter.llmStart(2, 567);
  reporter.llmEnd(2, 567);
  assert.deepEqual(events.map((event) => event.kind), ['preflight_start', 'preflight_done', 'llm_start', 'llm_end']);
  const start = events[0] as Extract<RepoSearchProgressEvent, { kind: 'preflight_start' }>;
  assert.equal(start.taskId, 't1');
  assert.equal(start.turn, 2);
  assert.equal(start.maxTurns, 45);
  assert.equal(start.promptChars, 1234);
  assert.ok(start.elapsedMs >= 0);
});

test('thinking/answer/toolStart/toolResult pass payloads through unchanged', () => {
  const { events, reporter } = collect();
  reporter.thinking(3, 'partial thought');
  reporter.answer(3, 'final answer');
  reporter.toolStart('tc_0', 3, 'rg -n foo', 500);
  reporter.toolResult({
    toolCallId: 'tc_0', turn: 3, command: 'rg -n foo', exitCode: 0,
    outputSnippet: 'snippet', outputTokens: 12, promptTokenCount: 500,
  });
  assert.deepEqual(events.map((event) => event.kind), ['thinking', 'answer', 'tool_start', 'tool_result']);
});

test('tokenizeStart/tokenizeDone mirror the preflight tokenize event shape', () => {
  const { events, reporter } = collect();
  reporter.tokenizeStart(1, 999);
  reporter.tokenizeDone(1, 999, {
    promptTokenCount: 40, tokenCountSource: 'server',
    tokenizeElapsedMs: 5, tokenizeRetryCount: 0,
    tokenizeTimeoutMs: 10_000, tokenizeRetryMaxWaitMs: 30_000,
    tokenizeStatus: 'ok', tokenizeErrorMessage: null,
  });
  assert.equal(events[0].kind, 'preflight_tokenize_start');
  assert.equal(events[1].kind, 'preflight_tokenize_done');
});
```

- [ ] **Step 2: Run it — verify it fails**

```powershell
npx tsx --test tests/engine-progress-reporter.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/repo-search/engine/progress-reporter.ts`**

Copy each event payload **verbatim** from the engine.ts lines listed above; the constants `tokenizeTimeoutMs: 10_000` / `tokenizeRetryMaxWaitMs: 30_000` for `tokenizeStart` match engine.ts 1030–1039.

```ts
import type { RepoSearchProgressEvent } from '../types.js';

export type TokenizeDoneInfo = {
  promptTokenCount: number;
  tokenCountSource?: string;
  tokenizeElapsedMs?: number | null;
  tokenizeRetryCount?: number | null;
  tokenizeTimeoutMs?: number;
  tokenizeRetryMaxWaitMs?: number;
  tokenizeStatus?: string | null;
  tokenizeErrorMessage?: string | null;
};

export class ProgressReporter {
  private readonly onProgress: ((event: RepoSearchProgressEvent) => void) | null;
  private readonly taskId: string;
  private readonly maxTurns: number;
  private readonly taskStartedAt: number;

  constructor(options: {
    onProgress: ((event: RepoSearchProgressEvent) => void) | null;
    taskId: string;
    maxTurns: number;
    taskStartedAt: number;
  }) {
    this.onProgress = options.onProgress;
    this.taskId = options.taskId;
    this.maxTurns = options.maxTurns;
    this.taskStartedAt = options.taskStartedAt;
  }

  get enabled(): boolean {
    return this.onProgress !== null;
  }

  private elapsedMs(): number {
    return Date.now() - this.taskStartedAt;
  }

  private emit(event: RepoSearchProgressEvent): void {
    this.onProgress?.(event);
  }

  preflightStart(turn: number, promptChars: number): void {
    this.emit({ kind: 'preflight_start', taskId: this.taskId, turn, maxTurns: this.maxTurns, promptChars, elapsedMs: this.elapsedMs() });
  }

  tokenizeStart(turn: number, promptChars: number): void {
    this.emit({
      kind: 'preflight_tokenize_start', taskId: this.taskId, turn, maxTurns: this.maxTurns, promptChars,
      tokenizeTimeoutMs: 10_000, tokenizeRetryMaxWaitMs: 30_000, elapsedMs: this.elapsedMs(),
    });
  }

  tokenizeDone(turn: number, promptChars: number, info: TokenizeDoneInfo): void {
    this.emit({
      kind: 'preflight_tokenize_done', taskId: this.taskId, turn, maxTurns: this.maxTurns, promptChars,
      promptTokenCount: info.promptTokenCount,
      tokenCountSource: info.tokenCountSource,
      tokenizeElapsedMs: info.tokenizeElapsedMs ?? undefined,
      tokenizeRetryCount: info.tokenizeRetryCount ?? undefined,
      tokenizeTimeoutMs: info.tokenizeTimeoutMs,
      tokenizeRetryMaxWaitMs: info.tokenizeRetryMaxWaitMs,
      tokenizeStatus: info.tokenizeStatus ?? undefined,
      errorMessage: info.tokenizeErrorMessage ?? undefined,
      elapsedMs: this.elapsedMs(),
    });
  }

  preflightDone(turn: number, promptChars: number, promptTokenCount: number): void {
    this.emit({ kind: 'preflight_done', taskId: this.taskId, turn, maxTurns: this.maxTurns, promptChars, promptTokenCount, elapsedMs: this.elapsedMs() });
  }

  llmStart(turn: number, promptTokenCount: number): void {
    this.emit({ kind: 'llm_start', turn, maxTurns: this.maxTurns, promptTokenCount, elapsedMs: this.elapsedMs() });
  }

  llmEnd(turn: number, promptTokenCount: number): void {
    this.emit({ kind: 'llm_end', turn, maxTurns: this.maxTurns, promptTokenCount, elapsedMs: this.elapsedMs() });
  }

  thinking(turn: number, thinkingText: string): void {
    this.emit({ kind: 'thinking', turn, maxTurns: this.maxTurns, thinkingText });
  }

  answer(turn: number, answerText: string): void {
    this.emit({ kind: 'answer', turn, maxTurns: this.maxTurns, answerText });
  }

  toolStart(toolCallId: string, turn: number, command: string, promptTokenCount: number): void {
    this.emit({ kind: 'tool_start', toolCallId, turn, maxTurns: this.maxTurns, command, promptTokenCount, elapsedMs: this.elapsedMs() });
  }

  toolResult(options: {
    toolCallId: string;
    turn: number;
    command: string;
    exitCode: number;
    outputSnippet: string;
    outputTokens: number;
    promptTokenCount: number;
  }): void {
    this.emit({ kind: 'tool_result', ...options, maxTurns: this.maxTurns, elapsedMs: this.elapsedMs() });
  }
}
```

If `RepoSearchProgressEvent` field optionality fights any payload above, match the event-union definition in `src/repo-search/types.ts` exactly — do NOT widen the union type.

- [ ] **Step 4: Add `"tests/engine-progress-reporter.test.ts"` to `tsconfig.test.json`; verify**

```powershell
npm run typecheck:test; if ($?) { npx tsx --test tests/engine-progress-reporter.test.ts }
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```powershell
git add src/repo-search/engine/progress-reporter.ts tests/engine-progress-reporter.test.ts tsconfig.test.json
git commit -m "feat(repo-search): add ProgressReporter class confining onProgress callback"
```

---

### Task 10: `TranscriptManager` class

**Files:**
- Create: `src/repo-search/engine/transcript-manager.ts`
- Test: `tests/engine-transcript-manager.test.ts`

Owns the `messages: ChatMessage[]` array (engine.ts 977–991), the `lastLoggedMessageCount` cursor (943, 1200–1201), compaction splice (1106–1107), batch append + duplicate replay overwrite (2092–2117, 1537–1542), and rendering.

- [ ] **Step 1: Write the failing test**

Create `tests/engine-transcript-manager.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { TranscriptManager } from '../src/repo-search/engine/transcript-manager.js';

function makeTranscript(): TranscriptManager {
  return new TranscriptManager({
    systemPromptContent: 'SYSTEM',
    historyMessages: [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'reply' }],
    initialUserContent: 'QUESTION',
  });
}

test('constructor builds system + history + initial user message in order', () => {
  const transcript = makeTranscript();
  const messages = transcript.getMessages();
  assert.equal(messages.length, 4);
  assert.deepEqual(messages.map((message) => message.role), ['system', 'user', 'assistant', 'user']);
  assert.equal(messages[0].content, 'SYSTEM');
  assert.equal(messages[3].content, 'QUESTION');
});

test('takeNewMessagesForLogging returns only messages appended since last call', () => {
  const transcript = makeTranscript();
  assert.equal(transcript.takeNewMessagesForLogging().length, 4);
  transcript.pushUser('extra');
  const fresh = transcript.takeNewMessagesForLogging();
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].content, 'extra');
  assert.equal(transcript.takeNewMessagesForLogging().length, 0);
});

test('replaceWith swaps content and resets the logging cursor', () => {
  const transcript = makeTranscript();
  transcript.takeNewMessagesForLogging();
  transcript.replaceWith([{ role: 'system', content: 'S2' }, { role: 'user', content: 'U2' }]);
  assert.equal(transcript.length, 2);
  assert.equal(transcript.takeNewMessagesForLogging().length, 2);
});

test('appendBatchExchange appends assistant tool_calls + tool results and returns pre-append length', () => {
  const transcript = makeTranscript();
  const preAppendLength = transcript.appendBatchExchange(
    [{ action: { tool_name: 'run_repo_cmd', args: { command: 'rg -n foo' } }, toolCallId: 'call_1', toolContent: 'result-text' }],
    'thinking-text',
  );
  assert.equal(preAppendLength, 4);
  const messages = transcript.getMessages();
  assert.equal(messages[4].role, 'assistant');
  assert.equal(messages[5].role, 'tool');
  assert.equal(messages[5].content, 'result-text');
  assert.equal(messages[5].tool_call_id, 'call_1');
});

test('replaceToolMessage overwrites in place preserving tool_call_id', () => {
  const transcript = makeTranscript();
  transcript.appendBatchExchange(
    [{ action: { tool_name: 'run_repo_cmd', args: { command: 'rg -n foo' } }, toolCallId: 'call_1', toolContent: 'original' }],
    '',
  );
  transcript.replaceToolMessage(5, 'duplicate command requested x2');
  const replaced = transcript.getMessages()[5];
  assert.equal(replaced.role, 'tool');
  assert.equal(replaced.tool_call_id, 'call_1');
  assert.equal(replaced.content, 'duplicate command requested x2');
});

test('upsertTrailingUser appends then updates the same trailing user message', () => {
  const transcript = makeTranscript();
  const firstIndex = transcript.upsertTrailingUser(-1, 'countdown 2');
  assert.equal(transcript.getMessages()[firstIndex].content, 'countdown 2');
  const secondIndex = transcript.upsertTrailingUser(firstIndex, 'countdown 1');
  assert.equal(secondIndex, firstIndex);
  assert.equal(transcript.length, 5);
  assert.equal(transcript.getMessages()[secondIndex].content, 'countdown 1');
});

test('render and renderTail produce transcripts', () => {
  const transcript = makeTranscript();
  assert.ok(transcript.render().includes('QUESTION'));
  assert.ok(!transcript.renderTail(2).includes('SYSTEM'));
});
```

- [ ] **Step 2: Run it — verify it fails**

```powershell
npx tsx --test tests/engine-transcript-manager.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/repo-search/engine/transcript-manager.ts`**

```ts
import { renderTaskTranscript, type ChatMessage } from '../planner-protocol.js';
import {
  appendToolCallExchange,
  appendToolBatchExchange,
  upsertTrailingUserMessage,
  type ToolBatchOutcome,
  type ToolTranscriptAction,
  type ToolTranscriptMessage,
} from '../../tool-call-messages.js';

export class TranscriptManager {
  private readonly messages: ChatMessage[];
  private lastLoggedMessageCount = 0;

  constructor(options: {
    systemPromptContent: string;
    historyMessages: ChatMessage[];
    initialUserContent: string;
  }) {
    this.messages = [
      { role: 'system', content: options.systemPromptContent },
      ...options.historyMessages,
      { role: 'user', content: options.initialUserContent },
    ];
  }

  get length(): number {
    return this.messages.length;
  }

  getMessages(): ChatMessage[] {
    return this.messages;
  }

  messageRoles(): string[] {
    return this.messages.map((message) => String(message.role || 'unknown'));
  }

  render(): string {
    return renderTaskTranscript(this.messages);
  }

  renderTail(skipCount: number): string {
    return renderTaskTranscript(this.messages.slice(skipCount));
  }

  replaceWith(compactedMessages: ChatMessage[]): void {
    this.messages.splice(0, this.messages.length, ...compactedMessages);
    this.lastLoggedMessageCount = 0;
  }

  takeNewMessagesForLogging(): ChatMessage[] {
    const fresh = this.messages.slice(this.lastLoggedMessageCount);
    this.lastLoggedMessageCount = this.messages.length;
    return fresh;
  }

  appendToolExchange(action: ToolTranscriptAction, toolCallId: string, toolContent: string, thinkingText: string): void {
    appendToolCallExchange(this.messages as unknown as ToolTranscriptMessage[], action, toolCallId, toolContent, thinkingText);
  }

  appendBatchExchange(outcomes: ToolBatchOutcome[], thinkingText: string): number {
    const preAppendLength = this.messages.length;
    appendToolBatchExchange(this.messages as unknown as ToolTranscriptMessage[], outcomes, thinkingText);
    return preAppendLength;
  }

  pushAssistant(message: ChatMessage): void {
    this.messages.push(message);
  }

  pushUser(content: string): void {
    this.messages.push({ role: 'user', content });
  }

  replaceToolMessage(index: number, content: string): void {
    const previousToolMessage = this.messages[index];
    this.messages[index] = {
      role: 'tool',
      tool_call_id: previousToolMessage?.tool_call_id,
      content,
    };
  }

  upsertTrailingUser(previousIndex: number, content: string): number {
    return upsertTrailingUserMessage(this.messages as unknown as ToolTranscriptMessage[], previousIndex, content);
  }
}
```

(If `ChatMessage` in `planner-protocol.ts` lacks `tool_call_id`, mirror the exact field access already done at engine.ts 1537–1542 — the cast pattern is identical to current code.)

- [ ] **Step 4: Add `"tests/engine-transcript-manager.test.ts"` to `tsconfig.test.json`; verify**

```powershell
npm run typecheck:test; if ($?) { npx tsx --test tests/engine-transcript-manager.test.ts }
```

Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```powershell
git add src/repo-search/engine/transcript-manager.ts tests/engine-transcript-manager.test.ts tsconfig.test.json
git commit -m "feat(repo-search): add TranscriptManager class owning planner messages"
```

---

### Task 11: `ToolResultBudgeter` class

**Files:**
- Create: `src/repo-search/engine/tool-result-budgeter.ts`
- Modify: `src/repo-search/engine.ts` (move `writeRedConsoleLine` + `ANSI_RED_CODE` here)
- Test: `tests/engine-tool-result-budgeter.test.ts`

Captures the token-count + fit + budget-reject block (engine.ts 1848–1936): raw tokenize, candidate tokenize, `ToolOutputFitter` fitting on success, and the budget-rejection error text on failure. `writeRedConsoleLine` (762–765) is only used here — move it into this module as a private function.

- [ ] **Step 1: Write the failing test**

Create `tests/engine-tool-result-budgeter.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { ToolResultBudgeter } from '../src/repo-search/engine/tool-result-budgeter.js';
import { estimateTokenCount } from '../src/repo-search/prompt-budget.js';

function makeBudgeter(): ToolResultBudgeter {
  // config undefined + useEstimatedTokensOnly -> pure char-based estimates, no HTTP.
  return new ToolResultBudgeter({ config: undefined, useEstimatedTokensOnly: true, timingRecorder: null });
}

test('result under both caps passes through unchanged', async () => {
  const budgeter = makeBudgeter();
  const resultText = 'line one\nline two';
  const fitted = await budgeter.fit({
    taskId: 't1', turn: 1, toolName: 'rg',
    resultText, rawResultText: resultText,
    perToolCapTokens: 10_000, remainingTokenAllowance: 10_000,
    commandSucceededForFitting: true, outputUnit: 'lines',
  });
  assert.equal(fitted.resultText, resultText);
  assert.equal(fitted.resultTokenCount, estimateTokenCount(undefined, resultText));
  assert.equal(fitted.resultTokenCountEstimated, true);
  assert.equal(fitted.fittedReturnedSegmentCount, null);
  assert.equal(fitted.rawResultTokenCount, estimateTokenCount(undefined, resultText));
});

test('oversized successful output is fitted down to the cap with a truncation marker', async () => {
  const budgeter = makeBudgeter();
  const lines = Array.from({ length: 200 }, (unused, index) => `match-line-${index}: some matched content`);
  const fitted = await budgeter.fit({
    taskId: 't1', turn: 1, toolName: 'rg',
    resultText: lines.join('\n'), rawResultText: lines.join('\n'),
    perToolCapTokens: 50, remainingTokenAllowance: 10_000,
    commandSucceededForFitting: true, outputUnit: 'lines',
  });
  assert.ok(fitted.fittedReturnedSegmentCount !== null);
  assert.ok(fitted.fittedReturnedSegmentCount < 200);
  assert.ok(fitted.resultTokenCount <= 50 + 25); // visible text + marker stays near cap
  assert.ok(fitted.resultText.length < lines.join('\n').length);
});

test('oversized failed output is replaced by the budget-rejection error text', async () => {
  const budgeter = makeBudgeter();
  const bigText = 'x'.repeat(5_000);
  const candidateTokens = estimateTokenCount(undefined, bigText);
  const fitted = await budgeter.fit({
    taskId: 't1', turn: 1, toolName: 'rg',
    resultText: bigText, rawResultText: bigText,
    perToolCapTokens: 10, remainingTokenAllowance: 20,
    commandSucceededForFitting: false, outputUnit: 'lines',
  });
  assert.equal(
    fitted.resultText,
    `Error: requested output would consume ${candidateTokens} tokens, remaining token allowance: 20, per tool call allowance: 10`,
  );
  assert.equal(fitted.fittedReturnedSegmentCount, null);
  assert.equal(fitted.resultTokenCountEstimated, true);
});
```

- [ ] **Step 2: Run it — verify it fails**

```powershell
npx tsx --test tests/engine-tool-result-budgeter.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/repo-search/engine/tool-result-budgeter.ts`**

The body is the engine.ts 1848–1936 block reshaped into a method. Copy expressions verbatim:

```ts
import { colorize } from '../../lib/text-format.js';
import type { TemporaryTimingRecorder } from '../../lib/temporary-timing-recorder.js';
import type { SiftConfig } from '../../config/index.js';
import { countTokensWithFallback, estimateTokenCount } from '../prompt-budget.js';
import { ToolOutputFitter, type ToolOutputTruncationUnit } from '../../tool-output-fit.js';

const ANSI_RED_CODE = 31;

function writeRedConsoleLine(message: string): void {
  if (!message) return;
  process.stderr.write(`${colorize(String(message), ANSI_RED_CODE, { isTTY: true })}\n`);
}

export type FittedToolResult = {
  resultText: string;
  resultTokenCount: number;
  resultTokenCountEstimated: boolean;
  fittedReturnedSegmentCount: number | null;
  rawResultTokenCount: number;
};

export class ToolResultBudgeter {
  private readonly config: SiftConfig | undefined;
  private readonly useEstimatedTokensOnly: boolean;
  private readonly timingRecorder: TemporaryTimingRecorder | null;

  constructor(options: {
    config: SiftConfig | undefined;
    useEstimatedTokensOnly: boolean;
    timingRecorder: TemporaryTimingRecorder | null;
  }) {
    this.config = options.config;
    this.useEstimatedTokensOnly = options.useEstimatedTokensOnly;
    this.timingRecorder = options.timingRecorder;
  }

  private async countTokens(text: string): Promise<number> {
    return this.useEstimatedTokensOnly
      ? estimateTokenCount(this.config, text)
      : await countTokensWithFallback(this.config, text);
  }

  async fit(options: {
    taskId: string;
    turn: number;
    toolName: string;
    resultText: string;
    rawResultText: string;
    perToolCapTokens: number;
    remainingTokenAllowance: number;
    commandSucceededForFitting: boolean;
    outputUnit: ToolOutputTruncationUnit;
  }): Promise<FittedToolResult> {
    const rawToolTokenSpan = this.timingRecorder?.start('repo.tool.tokenize_raw', {
      taskId: options.taskId, turn: options.turn, toolName: options.toolName, inputChars: options.rawResultText.length,
    });
    const rawResultTokenCount = await this.countTokens(options.rawResultText);
    rawToolTokenSpan?.end({ tokenCount: rawResultTokenCount });

    const promptToolTokenSpan = this.timingRecorder?.start('repo.tool.tokenize_prompt', {
      taskId: options.taskId, turn: options.turn, toolName: options.toolName, inputChars: options.resultText.length,
    });
    const candidateResultTokenCount = await this.countTokens(options.resultText);
    promptToolTokenSpan?.end({ tokenCount: candidateResultTokenCount });

    let resultText = options.resultText;
    let resultTokenCount = candidateResultTokenCount;
    let resultTokenCountEstimated = this.useEstimatedTokensOnly;
    let fittedReturnedSegmentCount: number | null = null;

    if (candidateResultTokenCount > options.perToolCapTokens || candidateResultTokenCount > options.remainingTokenAllowance) {
      if (options.commandSucceededForFitting) {
        const segments = resultText.split(/\r?\n/u).filter((line) => line.length > 0);
        const budgeter = this;
        const fitter = new ToolOutputFitter({
          async countToolOutputTokens(text: string): Promise<number> {
            return budgeter.countTokens(text);
          },
        });
        const fitResult = await fitter.fitSegments({
          headerText: undefined,
          segments,
          separator: '\n',
          maxTokens: Math.min(options.perToolCapTokens, Math.max(1, options.remainingTokenAllowance)),
          unit: options.outputUnit,
        });
        fittedReturnedSegmentCount = fitResult.returnedLineCount;
        resultText = fitResult.visibleText;
        const fitTokenSpan = this.timingRecorder?.start('repo.tool.tokenize_fit', {
          taskId: options.taskId, turn: options.turn, toolName: options.toolName, inputChars: resultText.length,
        });
        resultTokenCount = await this.countTokens(resultText);
        fitTokenSpan?.end({ tokenCount: resultTokenCount });
        resultTokenCountEstimated = this.useEstimatedTokensOnly;
      } else {
        resultText = `Error: requested output would consume ${candidateResultTokenCount} tokens, remaining token allowance: ${options.remainingTokenAllowance}, per tool call allowance: ${options.perToolCapTokens}`;
        writeRedConsoleLine(`repo_search warning: ${resultText}`);
        const rejectionToolTokenSpan = this.useEstimatedTokensOnly
          ? null
          : this.timingRecorder?.start('repo.tool.tokenize_rejection', {
            taskId: options.taskId, turn: options.turn, toolName: options.toolName, inputChars: resultText.length,
          });
        resultTokenCount = await this.countTokens(resultText);
        rejectionToolTokenSpan?.end({ tokenCount: resultTokenCount });
        resultTokenCountEstimated = this.useEstimatedTokensOnly;
      }
    }

    return { resultText, resultTokenCount, resultTokenCountEstimated, fittedReturnedSegmentCount, rawResultTokenCount };
  }
}
```

Note: the `const budgeter = this` + object-method form keeps `ToolOutputFitter`'s required interface satisfied without passing a bare function expression around — this mirrors the existing call shape at engine.ts 1888–1894.

- [ ] **Step 4: Delete `writeRedConsoleLine` + `ANSI_RED_CODE` from engine.ts**

They become unused once Task 18 swaps the block in; for now engine.ts still uses its own copies — leave engine.ts untouched in this task. (The delete happens in Task 18.)

- [ ] **Step 5: Add `"tests/engine-tool-result-budgeter.test.ts"` to `tsconfig.test.json`; verify**

```powershell
npm run typecheck:test; if ($?) { npx tsx --test tests/engine-tool-result-budgeter.test.ts }
```

Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```powershell
git add src/repo-search/engine/tool-result-budgeter.ts tests/engine-tool-result-budgeter.test.ts tsconfig.test.json
git commit -m "feat(repo-search): add ToolResultBudgeter class for tool output fitting"
```

---

### Task 12: `ReadWindowGovernor` class

**Files:**
- Create: `src/repo-search/engine/read-window-governor.ts`
- Modify: `src/repo-search/engine/read-overlap.ts` (line 7: add `export` to `type ParsedGetContentReadWindow`)
- Test: `tests/engine-read-window-governor.test.ts`

Owns `fileReadCountByPath` + `fileReadStateByPath` (engine.ts 965–966) and the four read-window blocks: adjustment planning (1654–1693), execution recording (1755–1783), native returned-range merge (1937–1959 — only the state-map part), and post-fit truncation accounting (1961–1981). The summary call (2232) becomes `governor.summary()`.

- [ ] **Step 1: Export the parsed-window type**

In `src/repo-search/engine/read-overlap.ts` change line 7 from `type ParsedGetContentReadWindow = {` to `export type ParsedGetContentReadWindow = {`.

- [ ] **Step 2: Write the failing test**

Create `tests/engine-read-window-governor.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { ReadWindowGovernor } from '../src/repo-search/engine/read-window-governor.js';
import type { ParsedGetContentReadWindow } from '../src/repo-search/engine/read-overlap.js';

function window(start: number, end: number): ParsedGetContentReadWindow {
  return {
    pathKey: 'src/a.ts',
    pathExpression: 'src/a.ts',
    requestedSkip: start - 1,
    requestedFirst: end - start,
    requestedStart: start,
    requestedEnd: end,
    hasExplicitSkip: true,
  };
}

test('planAdjustment returns null before any read of the file', () => {
  const governor = new ReadWindowGovernor();
  assert.equal(
    governor.planAdjustment({
      parsedReadWindow: window(1, 50),
      perToolCapTokens: 1000,
      currentGetContentStats: null,
      historicalGetContentStats: null,
    }),
    null,
  );
});

test('recordExecution tracks overlap across reads of the same file', () => {
  const governor = new ReadWindowGovernor();
  const first = governor.recordExecution({
    parsedReadWindow: window(1, 100), executedReadWindow: window(1, 100), turn: 1, adjusted: false,
  });
  assert.equal(first.overlapLines, 0);
  assert.equal(first.newLinesCovered, 99);
  assert.equal(first.cumulativeUniqueLines, 99);
  const second = governor.recordExecution({
    parsedReadWindow: window(50, 150), executedReadWindow: window(50, 150), turn: 2, adjusted: false,
  });
  assert.equal(second.overlapLines, 50);
  assert.equal(second.newLinesCovered, 50);
  assert.equal(second.cumulativeUniqueLines, 149);
});

test('recordExecution without a matching executed window only increments the read count', () => {
  const governor = new ReadWindowGovernor();
  const metrics = governor.recordExecution({
    parsedReadWindow: window(1, 10), executedReadWindow: null, turn: 1, adjusted: false,
  });
  assert.deepEqual(metrics, { overlapLines: 0, newLinesCovered: 0, cumulativeUniqueLines: 0 });
  // second call for the same path now sees a prior read -> planAdjustment can engage
  assert.equal(governor.readCount('src/a.ts'), 1);
});

test('applyFitTruncation rolls back unique-line accounting when output was cut', () => {
  const governor = new ReadWindowGovernor();
  const metrics = governor.recordExecution({
    parsedReadWindow: window(1, 100), executedReadWindow: window(1, 100), turn: 1, adjusted: false,
  });
  governor.applyFitTruncation({
    parsedReadWindow: window(1, 100), executedReadWindow: window(1, 100),
    fittedReturnedSegmentCount: 40, metrics,
  });
  assert.equal(metrics.newLinesCovered, 40);
  assert.equal(metrics.cumulativeUniqueLines, 40);
  const summary = governor.summary();
  assert.equal(summary.byFile.length, 1);
  assert.equal(summary.byFile[0].uniqueLinesRead, 40);
});

test('recordNativeReturnedRange merges returned ranges in the shared state map', () => {
  const governor = new ReadWindowGovernor();
  governor.recordNativeReturnedRange('src/a.ts', { start: 1, end: 20 });
  governor.recordNativeReturnedRange('src/a.ts', { start: 15, end: 30 });
  const state = governor.stateMap.get('src/a.ts');
  assert.deepEqual(state?.mergedReturnedRanges, [{ start: 1, end: 30 }]);
});
```

- [ ] **Step 3: Run it — verify it fails**

```powershell
npx tsx --test tests/engine-read-window-governor.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/repo-search/engine/read-window-governor.ts`**

All expressions are verbatim copies of the engine.ts blocks cited above:

```ts
import type { ToolTypeStats } from '../../status-server/metrics.js';
import {
  buildGetContentReadWindowCommand,
  buildReadOverlapSummary,
  computeAdjustedReadWindow,
  getOrCreateFileReadState,
  getPreviousExecutedMaxEnd,
  type LineReadAdjustment,
  LINE_READ_ROUNDING_STEP,
  mergeRange,
  overlapWithRanges,
  type ParsedGetContentReadWindow,
  REPEATED_LINE_READ_MIN_RATIO,
  type ReadRange,
  type ReadOverlapSummary,
  resolveAvgTokensPerLine,
  type FileReadState,
} from './read-overlap.js';

export type ReadExecutionMetrics = {
  overlapLines: number;
  newLinesCovered: number;
  cumulativeUniqueLines: number;
};

export type PlannedReadAdjustment = {
  commandToRun: string;
  adjustment: LineReadAdjustment;
};

export class ReadWindowGovernor {
  private readonly fileReadCountByPath = new Map<string, number>();
  private readonly fileReadStateByPath = new Map<string, FileReadState>();

  get stateMap(): Map<string, FileReadState> {
    return this.fileReadStateByPath;
  }

  readCount(pathKey: string): number {
    return Number(this.fileReadCountByPath.get(pathKey) || 0);
  }

  planAdjustment(options: {
    parsedReadWindow: ParsedGetContentReadWindow;
    perToolCapTokens: number;
    currentGetContentStats: ToolTypeStats | null;
    historicalGetContentStats: ToolTypeStats | null;
  }): PlannedReadAdjustment | null {
    const previousReadCount = this.readCount(options.parsedReadWindow.pathKey);
    if (previousReadCount < 1) {
      return null;
    }
    const minTokensFromCap = Math.max(1, Math.ceil(options.perToolCapTokens * REPEATED_LINE_READ_MIN_RATIO));
    const avgTokensPerLine = resolveAvgTokensPerLine(options.currentGetContentStats, options.historicalGetContentStats);
    const minLinesFromCap = Math.max(1, Math.ceil(minTokensFromCap / avgTokensPerLine));
    const existingReadState = getOrCreateFileReadState(this.fileReadStateByPath, options.parsedReadWindow.pathKey);
    const previousReturnedMaxEnd = existingReadState.mergedReturnedRanges.length > 0
      ? Math.max(...existingReadState.mergedReturnedRanges.map((range) => range.end))
      : getPreviousExecutedMaxEnd(existingReadState);
    const adjustedWindow = computeAdjustedReadWindow({
      requestedStart: options.parsedReadWindow.requestedStart,
      requestedEnd: options.parsedReadWindow.requestedEnd,
      minLinesFromCap,
      roundingStep: LINE_READ_ROUNDING_STEP,
      previousExecutedMaxEnd: previousReturnedMaxEnd,
    });
    if (!adjustedWindow.adjusted) {
      return null;
    }
    const adjustedFirst = Math.max(1, adjustedWindow.end - adjustedWindow.start);
    const commandToRun = buildGetContentReadWindowCommand(
      options.parsedReadWindow.pathExpression,
      adjustedWindow.start,
      adjustedFirst,
      options.parsedReadWindow.hasExplicitSkip,
    );
    return {
      commandToRun,
      adjustment: {
        executedCommand: commandToRun,
        requestedStart: options.parsedReadWindow.requestedStart,
        requestedEnd: options.parsedReadWindow.requestedEnd,
        adjustedStart: adjustedWindow.start,
        adjustedEnd: adjustedWindow.end,
        minLinesFromCap,
        perToolCapTokens: options.perToolCapTokens,
        reason: adjustedWindow.reason,
      },
    };
  }

  recordExecution(options: {
    parsedReadWindow: ParsedGetContentReadWindow;
    executedReadWindow: ParsedGetContentReadWindow | null;
    turn: number;
    adjusted: boolean;
  }): ReadExecutionMetrics {
    this.fileReadCountByPath.set(
      options.parsedReadWindow.pathKey,
      this.readCount(options.parsedReadWindow.pathKey) + 1,
    );
    const metrics: ReadExecutionMetrics = { overlapLines: 0, newLinesCovered: 0, cumulativeUniqueLines: 0 };
    if (!options.executedReadWindow || options.executedReadWindow.pathKey !== options.parsedReadWindow.pathKey) {
      return metrics;
    }
    const fileReadState = getOrCreateFileReadState(this.fileReadStateByPath, options.parsedReadWindow.pathKey);
    const executedRange: ReadRange = {
      start: options.executedReadWindow.requestedStart,
      end: options.executedReadWindow.requestedEnd,
    };
    const linesRead = Math.max(0, executedRange.end - executedRange.start);
    metrics.overlapLines = overlapWithRanges(fileReadState.mergedExecutedRanges, executedRange);
    metrics.newLinesCovered = Math.max(0, linesRead - metrics.overlapLines);
    fileReadState.totalLinesRead += linesRead;
    fileReadState.overlapLines += metrics.overlapLines;
    fileReadState.uniqueLinesRead += metrics.newLinesCovered;
    fileReadState.mergedExecutedRanges = mergeRange(fileReadState.mergedExecutedRanges, executedRange);
    fileReadState.windows.push({
      turn: options.turn,
      requestedStart: options.parsedReadWindow.requestedStart,
      requestedEnd: options.parsedReadWindow.requestedEnd,
      executedStart: executedRange.start,
      executedEnd: executedRange.end,
      adjusted: options.adjusted,
    });
    metrics.cumulativeUniqueLines = fileReadState.uniqueLinesRead;
    return metrics;
  }

  applyFitTruncation(options: {
    parsedReadWindow: ParsedGetContentReadWindow;
    executedReadWindow: ParsedGetContentReadWindow;
    fittedReturnedSegmentCount: number | null;
    metrics: ReadExecutionMetrics;
  }): void {
    if (options.executedReadWindow.pathKey !== options.parsedReadWindow.pathKey) {
      return;
    }
    const fileReadState = getOrCreateFileReadState(this.fileReadStateByPath, options.parsedReadWindow.pathKey);
    const executedLineCount = Math.max(0, options.executedReadWindow.requestedEnd - options.executedReadWindow.requestedStart);
    const returnedLineCount = Math.min(
      executedLineCount,
      options.fittedReturnedSegmentCount ?? executedLineCount,
    );
    if (options.fittedReturnedSegmentCount !== null && returnedLineCount < executedLineCount) {
      const adjustedNewLinesCovered = Math.min(options.metrics.newLinesCovered, returnedLineCount);
      fileReadState.totalLinesRead += returnedLineCount - executedLineCount;
      fileReadState.uniqueLinesRead += adjustedNewLinesCovered - options.metrics.newLinesCovered;
      options.metrics.newLinesCovered = adjustedNewLinesCovered;
      options.metrics.cumulativeUniqueLines = fileReadState.uniqueLinesRead;
    }
    if (returnedLineCount > 0) {
      fileReadState.mergedReturnedRanges = mergeRange(fileReadState.mergedReturnedRanges, {
        start: options.executedReadWindow.requestedStart,
        end: options.executedReadWindow.requestedStart + returnedLineCount,
      });
    }
  }

  recordNativeReturnedRange(pathKey: string, range: ReadRange): void {
    const fileReadState = getOrCreateFileReadState(this.fileReadStateByPath, pathKey);
    fileReadState.mergedReturnedRanges = mergeRange(fileReadState.mergedReturnedRanges, range);
  }

  summary(): ReadOverlapSummary {
    return buildReadOverlapSummary(this.fileReadStateByPath);
  }
}
```

- [ ] **Step 5: Add `"tests/engine-read-window-governor.test.ts"` to `tsconfig.test.json`; verify**

```powershell
npm run typecheck:test; if ($?) { npx tsx --test tests/engine-read-window-governor.test.ts }
```

Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```powershell
git add src/repo-search/engine/read-window-governor.ts src/repo-search/engine/read-overlap.ts tests/engine-read-window-governor.test.ts tsconfig.test.json
git commit -m "feat(repo-search): add ReadWindowGovernor class owning file read state"
```

---

### Task 13: `TerminalSynthesizer` class

**Files:**
- Create: `src/repo-search/engine/terminal-synthesizer.ts`
- Test: `tests/engine-terminal-synthesizer.test.ts`

Captures the synthesis-fallback block (engine.ts 2124–2207): prompt build, token sizing, 3-attempt retry, usage accounting, hard-fail. Behavior lock: `tests/repo-search-terminal-synthesis-retry.test.ts` already drives this path end-to-end.

**Before writing the test, read `requestTerminalSynthesis` in `src/repo-search/planner-protocol.ts` to confirm mock semantics** (mockResponses array indexed by mockResponseIndex; empty-string entry → empty text; index past end → `mockExhausted: true`). The test below assumes those semantics; adjust the mock arrays (not the assertions' meaning) if the function differs.

- [ ] **Step 1: Write the failing test**

Create `tests/engine-terminal-synthesizer.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { ProgressReporter } from '../src/repo-search/engine/progress-reporter.js';
import { TerminalSynthesizer } from '../src/repo-search/engine/terminal-synthesizer.js';
import { TokenUsageTracker } from '../src/repo-search/engine/token-usage.js';

function makeSynthesizer(tokenUsage: TokenUsageTracker): TerminalSynthesizer {
  return new TerminalSynthesizer({
    baseUrl: 'http://127.0.0.1:9', // never contacted in mock mode
    model: 'mock-model',
    timeoutMs: 1_000,
    config: undefined,
    useEstimatedTokensOnly: true,
    totalContextTokens: 32_000,
    thinkingEnabled: false,
    reasoningContentEnabled: false,
    preserveThinking: false,
    streamFinishAsAnswer: false,
    logger: null,
    progress: new ProgressReporter({ onProgress: null, taskId: 't1', maxTurns: 45, taskStartedAt: Date.now() }),
    tokenUsage,
  });
}

test('synthesize returns the first non-empty mock response', async () => {
  const tokenUsage = new TokenUsageTracker(undefined);
  const synthesizer = makeSynthesizer(tokenUsage);
  const result = await synthesizer.synthesize({
    taskId: 't1', question: 'q', reason: 'max_turns', transcript: 'evidence', turnsUsed: 3,
    mockResponses: ['synthesized answer'], mockResponseIndex: 0,
  });
  assert.equal(result.finalOutput, 'synthesized answer');
  assert.ok(tokenUsage.snapshot().outputTokens > 0);
});

test('synthesize retries past empty responses', async () => {
  const synthesizer = makeSynthesizer(new TokenUsageTracker(undefined));
  const result = await synthesizer.synthesize({
    taskId: 't1', question: 'q', reason: 'max_turns', transcript: 'evidence', turnsUsed: 3,
    mockResponses: ['', 'second try answer'], mockResponseIndex: 0,
  });
  assert.equal(result.finalOutput, 'second try answer');
});

test('synthesize hard-fails after three unusable attempts', async () => {
  const synthesizer = makeSynthesizer(new TokenUsageTracker(undefined));
  await assert.rejects(
    synthesizer.synthesize({
      taskId: 't1', question: 'q', reason: 'max_turns', transcript: 'evidence', turnsUsed: 3,
      mockResponses: [], mockResponseIndex: 0,
    }),
    /Terminal synthesis produced no usable output after 3 attempts/u,
  );
});
```

- [ ] **Step 2: Run it — verify it fails**

```powershell
npx tsx --test tests/engine-terminal-synthesizer.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/repo-search/engine/terminal-synthesizer.ts`**

Body is engine.ts 2124–2207 reshaped; all strings/log kinds verbatim:

```ts
import type { SiftConfig } from '../../config/index.js';
import { getDynamicMaxOutputTokens } from '../../lib/dynamic-output-cap.js';
import { requestTerminalSynthesis } from '../planner-protocol.js';
import { countTokensWithFallback } from '../prompt-budget.js';
import { buildTerminalSynthesisPrompt } from '../prompts.js';
import type { JsonLogger } from '../types.js';
import { ProgressReporter } from './progress-reporter.js';
import { TokenUsageTracker } from './token-usage.js';

const MAX_SYNTHESIS_ATTEMPTS = 3;

export class TerminalSynthesizer {
  constructor(private readonly options: {
    baseUrl: string;
    model: string;
    timeoutMs: number;
    config: SiftConfig | undefined;
    useEstimatedTokensOnly: boolean;
    totalContextTokens: number;
    thinkingEnabled: boolean;
    reasoningContentEnabled: boolean;
    preserveThinking: boolean;
    streamFinishAsAnswer: boolean;
    logger: JsonLogger | null;
    progress: ProgressReporter;
    tokenUsage: TokenUsageTracker;
  }) {}

  async synthesize(input: {
    taskId: string;
    question: string;
    reason: string;
    transcript: string;
    turnsUsed: number;
    mockResponses?: string[];
    mockResponseIndex: number;
  }): Promise<{ finalOutput: string; nextMockResponseIndex: number }> {
    const synthesisPrompt = buildTerminalSynthesisPrompt({
      question: input.question,
      reason: input.reason,
      transcript: input.transcript,
    });
    const synthesisPromptTokenCount = await countTokensWithFallback(
      this.options.useEstimatedTokensOnly ? undefined : this.options.config,
      synthesisPrompt,
    );
    const synthesisMaxTokens = getDynamicMaxOutputTokens({
      totalContextTokens: this.options.totalContextTokens,
      promptTokenCount: synthesisPromptTokenCount,
    });
    this.options.logger?.write({
      kind: 'task_terminal_synthesis_requested',
      taskId: input.taskId,
      reason: input.reason,
      promptTokenCount: synthesisPromptTokenCount,
      maxOutputTokens: synthesisMaxTokens,
    });
    let mockResponseIndex = input.mockResponseIndex;
    let finalOutput = '';
    let lastErrorMessage = '';
    let successAttempt = 0;
    for (let attempt = 1; attempt <= MAX_SYNTHESIS_ATTEMPTS; attempt += 1) {
      try {
        const synthesisResponse = await requestTerminalSynthesis({
          baseUrl: this.options.baseUrl,
          model: this.options.model,
          prompt: synthesisPrompt,
          timeoutMs: this.options.timeoutMs,
          mockResponses: input.mockResponses,
          mockResponseIndex,
          maxTokens: synthesisMaxTokens,
          thinkingEnabled: this.options.thinkingEnabled,
          reasoningContentEnabled: this.options.reasoningContentEnabled,
          preserveThinking: this.options.preserveThinking,
          logger: this.options.logger,
          stream: this.options.streamFinishAsAnswer && this.options.progress.enabled,
          onContentDelta: this.options.streamFinishAsAnswer && this.options.progress.enabled
            ? (answerText: string) => { this.options.progress.answer(input.turnsUsed, answerText); }
            : undefined,
        });
        if (typeof synthesisResponse.nextMockResponseIndex === 'number') {
          mockResponseIndex = synthesisResponse.nextMockResponseIndex;
        }
        const resolved = this.options.tokenUsage.recordModelResponse(synthesisResponse);
        this.options.tokenUsage.addOutputTokens(resolved.completionTokens);

        const text = String(synthesisResponse.text || '').trim();
        if (!synthesisResponse.mockExhausted && text) {
          finalOutput = text;
          if (this.options.streamFinishAsAnswer && this.options.progress.enabled) {
            this.options.progress.answer(input.turnsUsed, finalOutput);
          }
          successAttempt = attempt;
          break;
        }
        lastErrorMessage = synthesisResponse.mockExhausted ? 'mock_exhausted' : 'empty_output';
        this.options.logger?.write({ kind: 'task_terminal_synthesis_retry', taskId: input.taskId, attempt, error: lastErrorMessage });
      } catch (error) {
        lastErrorMessage = error instanceof Error ? error.message : String(error);
        this.options.logger?.write({ kind: 'task_terminal_synthesis_retry', taskId: input.taskId, attempt, error: lastErrorMessage });
      }
    }
    if (!String(finalOutput || '').trim()) {
      this.options.logger?.write({ kind: 'task_terminal_synthesis_failed', taskId: input.taskId, reason: input.reason, lastError: lastErrorMessage });
      throw new Error(`Terminal synthesis produced no usable output after ${MAX_SYNTHESIS_ATTEMPTS} attempts (reason=${input.reason}, last=${lastErrorMessage || 'unknown'}).`);
    }
    this.options.logger?.write({ kind: 'task_terminal_synthesis_result', taskId: input.taskId, attempt: successAttempt, finalOutput });
    return { finalOutput, nextMockResponseIndex: mockResponseIndex };
  }
}
```

Behavior note (intentional, verify in Step 4): the original code counted synthesis usage via the same `Number.isFinite` guards now inside `TokenUsageTracker.recordModelResponse` — identical math, including `addOutputTokens(resolved.completionTokens)` matching old line 2179. The original streamed `kind: 'answer'` with `turn: turnsUsed` — preserved via `progress.answer(input.turnsUsed, ...)`.

- [ ] **Step 4: Add `"tests/engine-terminal-synthesizer.test.ts"` to `tsconfig.test.json`; verify**

```powershell
npm run typecheck:test; if ($?) { npx tsx --test tests/engine-terminal-synthesizer.test.ts }
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```powershell
git add src/repo-search/engine/terminal-synthesizer.ts tests/engine-terminal-synthesizer.test.ts tsconfig.test.json
git commit -m "feat(repo-search): add TerminalSynthesizer class"
```

---

## Phase B — swap the classes into `runTaskLoop`

Each task below edits ONLY `src/repo-search/engine.ts`, replacing inline code with calls into the Phase A classes. No new tests — the LOOP SUITE plus the full unit-test set is the gate. After each task run:

```powershell
npm run typecheck:test; if ($?) { npx tsx --test tests/repo-search-loop.core.test.ts tests/mock-repo-search-loop.test.ts tests/repo-search.test.ts tests/repo-search-terminal-synthesis-retry.test.ts tests/repo-search-logging.test.ts tests/tool-command-display.test.ts tests/repo-search-chat-loop.test.ts tests/repo-search-chat-execute.test.ts tests/repo-search-planner-empty-tools.test.ts }
```

Expected after every task: typecheck clean, 0 test failures. If a test fails, diff the failing assertion against the moved expression — you copied something non-verbatim. Fix forward; do not weaken tests.

### Task 14: Integrate `TokenUsageTracker` + `TurnBudget`

**Files:** Modify: `src/repo-search/engine.ts`

- [ ] **Step 1: Replace declarations** (lines 903–915):

Delete the eight `let model*Tokens/DurationMs = 0;` lines and the `totalContextTokens`/`thinkingBufferTokens`/`usablePromptTokens` consts. Insert:

```ts
const tokenUsage = new TokenUsageTracker(options.config);
const budget = new TurnBudget({
  totalContextTokens: Math.max(1, Number(options.totalContextTokens || (options.config ? getConfiguredLlamaNumCtx(options.config) : 32000))),
  maxTurns,
});
```

Add imports: `import { TokenUsageTracker } from './engine/token-usage.js';` and `import { PER_TOOL_RESULT_RATIO, TurnBudget } from './engine/turn-budget.js';` (drop `PER_TOOL_RESULT_RATIO` from the import if Step 3 leaves no uses). Delete engine.ts constants `THINKING_BUFFER_RATIO`, `THINKING_BUFFER_MIN_TOKENS`, `PER_TOOL_RESULT_RATIO` (lines 145–147).

- [ ] **Step 2: Rename remaining references**

`totalContextTokens` → `budget.totalContextTokens` (sites: 1008/1114 prompt-reserve `maxTokens`, 1045/1134 preflight, 1081/1159 + 2134 `getDynamicMaxOutputTokens`, 1181/1190 overflow error/log). `thinkingBufferTokens` → `budget.thinkingBufferTokens` (1046/1134, 1182, 1190). `usablePromptTokens` → gone; only used via the cap helpers replaced in Step 3.

- [ ] **Step 3: Replace cap math**

- Line 1648–1649 → `const preExecutionPerToolCapTokens = budget.perToolCapTokens(commands.length);`
- Line 1861–1862 → `const perToolCapTokens = budget.perToolCapTokens(commands.length);`
- Lines 1863–1866 → `const remainingTokenAllowance = budget.remainingToolAllowance(promptTokenCount, acceptedToolPromptTokensThisTurn);`

- [ ] **Step 4: Replace usage accounting**

- Lines 1273–1284 → 

```ts
const resolvedCompletionTokens = tokenUsage.recordModelResponse(response).completionTokens;
```

- Lines 1300, 1330: `modelOutputTokens += resolvedCompletionTokens;` → `tokenUsage.addOutputTokens(resolvedCompletionTokens);`
- Line 2057: `modelToolTokens += Math.max(0, Math.ceil(resultTokenCount));` → `tokenUsage.addToolTokens(resultTokenCount);`
- Synthesis block lines 2169–2184: keep `nextMockResponseIndex` handling, replace the usage-guard block with

```ts
const resolved = tokenUsage.recordModelResponse(synthesisResponse);
tokenUsage.addOutputTokens(resolved.completionTokens);
```

(This whole block moves out in Task 19; the interim state must still pass the suite.)

- [ ] **Step 5: Replace the TaskResult tail** (lines 2223–2230): the eight `promptTokens: modelPromptTokens, ...` lines → `...tokenUsage.snapshot(),` (snapshot keys are exactly those eight TaskResult fields).

- [ ] **Step 6: Typecheck + LOOP SUITE** (command above). Expected: 0 fail.

- [ ] **Step 7: Commit**

```powershell
git add src/repo-search/engine.ts
git commit -m "refactor(repo-search): route token accounting through TokenUsageTracker and TurnBudget"
```

### Task 15: Integrate `ToolStatsRecorder`

**Files:** Modify: `src/repo-search/engine.ts`

- [ ] **Step 1:** Replace `const toolStatsByType: Record<string, ToolTypeStats> = {};` (line 911) with `const toolStats = new ToolStatsRecorder();` plus import `import { ToolStatsRecorder } from './engine/tool-stats.js';`.

- [ ] **Step 2:** Replace each mutation site:
  - 1338–1341 and 1350–1354 (both finish-rejection blocks) → `toolStats.recordFinishRejection();`
  - 1557–1562 → `toolStats.recordSemanticRepeatReject(prospectiveToolType);`
  - 1575–1578 → `toolStats.recordForcedFinishFromStagnation(prospectiveToolType);`
  - 1658: `toolStatsByType['get-content'] || null` → `toolStats.get('get-content')`
  - 1985–1997 → `toolStats.recordToolCall({ toolType, resultTextLength: resultText.length, resultTokenCount, resultTokenCountEstimated, rawResultTokenCount, lineReadStats: lineReadStats || null });`
  - 2004–2008 → `toolStats.recordNovelty(toolType, novelty.hasNewEvidence);`
  - 2231: `toolStats: { ...toolStatsByType },` → `toolStats: toolStats.snapshot(),`

Remove the now-unused `createEmptyToolTypeStats` import if no other engine.ts site uses it (check `historicalToolStats` block first).

- [ ] **Step 3: Typecheck + LOOP SUITE.** Expected: 0 fail (stats assertions in `mock-repo-search-loop.test.ts` are the sharp edge here).

- [ ] **Step 4: Commit**

```powershell
git add src/repo-search/engine.ts
git commit -m "refactor(repo-search): route tool stats through ToolStatsRecorder"
```

### Task 16: Integrate `DuplicateTracker` + `ForcedFinishController`

**Files:** Modify: `src/repo-search/engine.ts`

- [ ] **Step 1:** Delete locals `zeroOutputStreak`, `forcedFinishAttemptsRemaining` (941–942) and `lastSuccessfulNormalizedKey`, `lastSuccessfulFingerprint`, `duplicateReplayFingerprint`, `duplicateReplayCount`, `duplicateReplayToolMessageIndex` (959–963). Insert:

```ts
const duplicates = new DuplicateTracker();
const forcedFinish = new ForcedFinishController();
```

Imports: `import { DuplicateTracker } from './engine/duplicate-tracker.js';` and `import { FORCED_FINISH_MAX_ATTEMPTS, ForcedFinishController } from './engine/forced-finish.js';`. Delete engine constants `ZERO_OUTPUT_FORCE_THRESHOLD`, `FORCED_FINISH_MAX_ATTEMPTS`, `DUPLICATE_FORCE_THRESHOLD` (148–150).

- [ ] **Step 2:** Line 996 → `const inForcedFinishMode = forcedFinish.isActive();`

- [ ] **Step 3:** Forced-finish consumption (1457–1474) becomes:

```ts
if (inForcedFinishMode) {
  const attempt = forcedFinish.consumeAttempt();
  commandFailures += 1;
  commands.push({ command, turn, safe: false, reason: attempt.rejectionReason, exitCode: null, output: `Rejected command: ${attempt.rejectionReason}` });
  batchOutcomes.push({
    action: buildEffectiveTranscriptAction({ toolName: normalizedToolName, rawArgs: toolAction.args, isNativeTool, commandToRun: command }),
    toolCallId: `forced_finish_call_${commands.length}`,
    toolContent: `Rejected command: ${attempt.rejectionReason}`,
  });
  pendingForcedFinishCountdownText = attempt.countdownText;
  if (attempt.exhausted) { reason = 'forced_finish_attempt_limit'; break; }
  continue;
}
```

- [ ] **Step 4:** Duplicate classification (1497–1499) becomes:

```ts
const duplicateClassification = duplicates.classify({ toolName: normalizedToolName, normalizedKey, fingerprint, rejected: !isNativeTool && normalized.rejected });
const { isExactDuplicate, isSemanticDuplicate, duplicateFingerprint } = duplicateClassification;
```

(Match the original semantics exactly: original `isSemanticDuplicate` used `!normalized.rejected`; for native tools `normalized` is the `{ rejected: false }` literal, so `!isNativeTool && normalized.rejected` is equivalent — for native tools `normalized.rejected` is already `false`. Simply pass `rejected: normalized.rejected`.)

- [ ] **Step 5:** Duplicate registration (1526–1556) becomes:

```ts
if (!canAdvanceRepeatedRead && (isExactDuplicate || isSemanticDuplicate)) {
  const registration = duplicates.registerDuplicate(duplicateFingerprint, messages.length);
  const duplicateMessage = buildRepeatedToolCallSummary(normalizedToolName, registration.count);
  commandFailures += 1;
  const rejectionReason = isExactDuplicate ? 'duplicate command' : 'semantic duplicate command';
  commands.push({ command, turn, safe: false, reason: rejectionReason, exitCode: null, output: `Rejected: ${duplicateMessage}` });
  if (registration.activeReplayMessageIndex !== null) {
    const previousToolMessage = messages[registration.activeReplayMessageIndex];
    messages[registration.activeReplayMessageIndex] = { role: 'tool', tool_call_id: previousToolMessage?.tool_call_id, content: duplicateMessage };
  } else {
    const duplicateToolCallId = `duplicate_call_${commands.length}`;
    batchOutcomes.push({
      action: buildEffectiveTranscriptAction({ toolName: normalizedToolName, rawArgs: toolAction.args, isNativeTool, commandToRun: command }),
      toolCallId: duplicateToolCallId,
      toolContent: duplicateMessage,
    });
    batchDuplicateAnchorIndex = batchOutcomes.length - 1;
  }
```

then the semantic-repeat log block keeps `repeats: registration.count`, and the force trigger (1572–1586) becomes:

```ts
  if (duplicates.shouldForceFinish() && !forcedFinish.isActive()) {
    pendingModeChangeUserMessages.push(forcedFinish.activateFromStagnation());
    toolStats.recordForcedFinishFromStagnation(prospectiveToolType);
    options.logger?.write({
      kind: 'turn_forced_finish_mode_started',
      taskId: task.id,
      turn,
      attemptsRemaining: FORCED_FINISH_MAX_ATTEMPTS,
      trigger: isSemanticDuplicate ? 'semantic_repetition' : 'consecutive_duplicates',
    });
  }
  continue;
}
```

- [ ] **Step 6:** Zero-output block (1806–1825) becomes:

```ts
let zeroOutputWarningText = '';
const zeroOutputObservation = forcedFinish.recordToolOutput(baseOutput.length);
if (baseOutput.length === 0) {
  zeroOutputWarningText = zeroOutputObservation.warningText;
  options.logger?.write({
    kind: 'turn_zero_output_countdown', taskId: task.id, turn,
    zeroOutputStreak: zeroOutputObservation.zeroOutputStreak,
    remainingBeforeForce: zeroOutputObservation.remainingBeforeForce,
  });
  if (zeroOutputObservation.activated) {
    pendingModeChangeUserMessages.push(FORCED_FINISH_MODE_MESSAGE);
    options.logger?.write({
      kind: 'turn_forced_finish_mode_started', taskId: task.id, turn, attemptsRemaining: FORCED_FINISH_MAX_ATTEMPTS,
    });
  }
}
```

Also import `FORCED_FINISH_MODE_MESSAGE` from `./engine/forced-finish.js`.

- [ ] **Step 7:** Success reset (2070–2077) → `if (commandSucceeded) { duplicates.recordSuccess(normalizedKey, fingerprint || null); }`. Anchor update (2105–2107) → `if (batchDuplicateAnchorIndex !== null && batchOutcomes.length > 0) { duplicates.setReplayToolMessageIndex(preAppendMessagesLength + 1 + batchDuplicateAnchorIndex); }`. The `minToolCallsBeforeFinish` log field (1345) is unaffected.

- [ ] **Step 8: Typecheck + LOOP SUITE.** Expected: 0 fail (duplicate/forced-finish scenarios in `repo-search-loop.core.test.ts` are the sharp edge).

- [ ] **Step 9: Commit**

```powershell
git add src/repo-search/engine.ts
git commit -m "refactor(repo-search): route duplicate + forced-finish state through tracker classes"
```

### Task 17: Integrate `ProgressReporter` + `TranscriptManager`

**Files:** Modify: `src/repo-search/engine.ts`

- [ ] **Step 1: Instantiate both** right after `const taskStartedAt = Date.now();` / system-prompt build (968–991):

```ts
const progress = new ProgressReporter({
  onProgress: options.onProgress || null,
  taskId: task.id,
  maxTurns,
  taskStartedAt,
});
```

and replace the `const messages: ChatMessage[] = [...]` literal (977–991) with:

```ts
const transcript = new TranscriptManager({
  systemPromptContent,
  historyMessages: options.historyMessages || [],
  initialUserContent: loopKind === 'chat'
    ? task.question
    : buildTaskInitialUserPrompt(task.question, bootstrapFileList, {
      includeRepoFileListing: options.includeRepoFileListing,
    }),
});
const messages = transcript.getMessages();
```

Keeping the `messages` alias makes this task a small diff; later tasks remove direct uses. Imports: `import { ProgressReporter } from './engine/progress-reporter.js';`, `import { TranscriptManager } from './engine/transcript-manager.js';`.

- [ ] **Step 2: Replace every `options.onProgress` site with the reporter:**

| Old site (line) | New call |
|---|---|
| 1020–1027 `preflight_start` | `progress.preflightStart(turn, prompt.length);` |
| 1030–1040 + 1121–1132 `preflight_tokenize_start` (guarded by `preflightConfig`) | `if (preflightConfig) { progress.tokenizeStart(turn, prompt.length); }` |
| 1053–1061 `preflight_done` | `progress.preflightDone(turn, prompt.length, preflight.promptTokenCount);` |
| 1062–1079 + 1136–1153 `preflight_tokenize_done` (guarded by `tokenizationAttempted`) | `if (preflight.tokenizationAttempted) { progress.tokenizeDone(turn, prompt.length, preflight); }` (and the `afterCompaction` twin) |
| 1197–1199 `llm_start` / 1250–1252 `llm_end` | `progress.llmStart(turn, preflight.promptTokenCount);` / `progress.llmEnd(turn, preflight.promptTokenCount);` |
| 1012 / 1118 / 1223 `stream: Boolean(options.onProgress)` | `stream: progress.enabled` |
| 1224–1239 `onThinkingDelta`/`onContentDelta` | keep the same conditional shape but gate on `progress.enabled` and call `progress.thinking(turn, ...)` / `progress.answer(turn, ...)` inside |
| 1325–1327 thinking emit | `if (response.thinkingText) { progress.thinking(turn, response.thinkingText); }` |
| 1366–1368 finish answer | `if (streamFinishAsAnswer) { progress.answer(turn, finalOutput); }` |
| 1723–1725 `tool_start` | `progress.toolStart(progressToolCallId, turn, requestedCommand, promptTokenCount);` |
| 2019–2033 `tool_result` | `if (progress.enabled) { const snippet = resultText.length > 200 ? \`${resultText.slice(0, 200)}...\` : resultText; progress.toolResult({ toolCallId: progressToolCallId, turn, command: modelVisibleCommand, exitCode: executed.exitCode, outputSnippet: snippet, outputTokens: resultTokenCount, promptTokenCount }); }` |
| 2163–2167, 2189–2191 synthesis answer | leave for Task 19 |

- [ ] **Step 3: Replace transcript bookkeeping:**

- 1006 / 1112 `messages.map((message) => String(message.role || 'unknown'))` → `transcript.messageRoles()`
- 1014 / 1120 `renderTaskTranscript(messages)` → `transcript.render()`
- 1100–1107 compaction: `compactPlannerMessagesOnce({ messages: transcript.getMessages(), ... })` then `transcript.replaceWith(compacted.messages);` — delete `lastLoggedMessageCount = 0;` (handled inside)
- 1200–1202 → `const newMessages = transcript.takeNewMessagesForLogging();` — delete the `lastLoggedMessageCount` local (943)
- 1304–1310 → `transcript.appendToolExchange(invalidToolAction, \`invalid_call_${invalidResponses}\`, invalidActionMessage, String(response.thinkingText || '').trim());`
- 1343–1344 / 1355–1356 finish rejections → `transcript.pushAssistant(buildAssistantReplayMessage(response.text, String(response.thinkingText || '').trim())); transcript.pushUser(warning);` (and `groundingDecision.message`)
- 1537–1542 duplicate overwrite → `transcript.replaceToolMessage(registration.activeReplayMessageIndex, duplicateMessage);`
- duplicate registration `messages.length` → `transcript.length`
- 2092–2104 → `const preAppendMessagesLength = transcript.appendBatchExchange(batchOutcomes, String(response.thinkingText || '').trim());` (keep the timing span around it; its `beforeMessageCount`/`afterMessageCount` use `transcript.length` before/after)
- 2108–2110 → `for (const userMessage of pendingModeChangeUserMessages) { transcript.pushUser(userMessage); }`
- 2111–2117 → `forcedFinishCountdownUserMessageIndex = transcript.upsertTrailingUser(forcedFinishCountdownUserMessageIndex, pendingForcedFinishCountdownText);`
- 2128 synthesis transcript → `transcript.renderTail(2)`
- `requestPlannerAction({ ..., messages: transcript.getMessages(), ... })`
- Delete the `const messages = transcript.getMessages();` alias once all sites are converted; remove unused imports (`renderTaskTranscript`, `appendToolCallExchange`, `appendToolBatchExchange`, `upsertTrailingUserMessage`, `ToolTranscriptMessage`) from engine.ts.

- [ ] **Step 4: Typecheck + LOOP SUITE.** Expected: 0 fail (`repo-search-logging.test.ts` asserts `turn_new_messages` payloads — sharp edge for the cursor move).

- [ ] **Step 5: Commit**

```powershell
git add src/repo-search/engine.ts
git commit -m "refactor(repo-search): route progress events and transcript through dedicated classes"
```

### Task 18: Integrate `ToolResultBudgeter` + `ReadWindowGovernor`

**Files:** Modify: `src/repo-search/engine.ts`

- [ ] **Step 1: Instantiate** near the other constructions:

```ts
const resultBudgeter = new ToolResultBudgeter({
  config: options.config,
  useEstimatedTokensOnly,
  timingRecorder: options.timingRecorder || null,
});
const readWindows = new ReadWindowGovernor();
```

Delete locals `fileReadCountByPath`, `fileReadStateByPath` (965–966). All previous `fileReadStateByPath` arguments (`planRepoReadFile`, `executeNativeRepoTool` call sites at 1591, 1608) become `readWindows.stateMap`.

- [ ] **Step 2: Replace the adjustment block** (1654–1693):

```ts
let commandToRun = normalizedCommand;
let lineReadAdjustment: LineReadAdjustment | null = null;
if (parsedReadWindow) {
  const planned = readWindows.planAdjustment({
    parsedReadWindow,
    perToolCapTokens: preExecutionPerToolCapTokens,
    currentGetContentStats: toolStats.get('get-content'),
    historicalGetContentStats: historicalToolStats['get-content'] || null,
  });
  if (planned) {
    commandToRun = planned.commandToRun;
    lineReadAdjustment = planned.adjustment;
  }
}
```

- [ ] **Step 3: Replace execution recording** (1755–1783):

```ts
let readMetrics = { overlapLines: 0, newLinesCovered: 0, cumulativeUniqueLines: 0 };
if (parsedReadWindow) {
  readMetrics = readWindows.recordExecution({
    parsedReadWindow,
    executedReadWindow,
    turn,
    adjusted: Boolean(lineReadAdjustment),
  });
}
```

Downstream reads `lineReadOverlapLines`/`lineReadNewLinesCovered`/`lineReadCumulativeUniqueLines` → `readMetrics.overlapLines`/`.newLinesCovered`/`.cumulativeUniqueLines` (log payload at 2050–2052 keeps its `executedReadWindow ? ... : undefined` guards).

- [ ] **Step 4: Replace the tokenize/fit block** (1848–1936):

```ts
const fitted = await resultBudgeter.fit({
  taskId: task.id,
  turn,
  toolName: normalizedToolName,
  resultText,
  rawResultText,
  perToolCapTokens,
  remainingTokenAllowance,
  commandSucceededForFitting: Number(executed.exitCode) === 0 || searchExit.noMatch,
  outputUnit: nativeExecution && nativeExecution.ok && nativeExecution.outputUnit ? nativeExecution.outputUnit : 'lines',
});
resultText = fitted.resultText;
const resultTokenCount = fitted.resultTokenCount;
const resultTokenCountEstimated = fitted.resultTokenCountEstimated;
const fittedReturnedSegmentCount = fitted.fittedReturnedSegmentCount;
const rawResultTokenCount = fitted.rawResultTokenCount;
```

Then re-derive `lineReadStats` exactly as before (1858–1860 used `rawResultTokenCount`; keep that statement, it now reads `fitted.rawResultTokenCount`). Delete `writeRedConsoleLine` + `ANSI_RED_CODE` from engine.ts (762–765, 151) and the `colorize` import if unused.

- [ ] **Step 5: Replace the post-fit read-state blocks:**

- Native block 1937–1959: keep the `commandToRun`/`lineReadStats` rebuild, but replace the two `getOrCreateFileReadState`/`mergeRange` statements with `readWindows.recordNativeReturnedRange(nativeExecution.readFile.pathKey, { start: nativeExecution.readFile.startLine, end: returnedEndLineExclusive });`
- Non-native block 1961–1981 → 

```ts
if (!isNativeTool && parsedReadWindow && executedReadWindow) {
  readWindows.applyFitTruncation({ parsedReadWindow, executedReadWindow, fittedReturnedSegmentCount, metrics: readMetrics });
}
```

- Line 2232 `buildReadOverlapSummary(fileReadStateByPath)` → `readWindows.summary()`. Remove now-unused read-overlap imports from engine.ts (`computeAdjustedReadWindow`, `mergeRange`, `overlapWithRanges`, `getOrCreateFileReadState`, `getPreviousExecutedMaxEnd`, `resolveAvgTokensPerLine`, `buildGetContentReadWindowCommand`, `LINE_READ_ROUNDING_STEP`, `REPEATED_LINE_READ_MIN_RATIO`, `buildReadOverlapSummary`, `ReadRange` — keep `parseGetContentReadWindowCommand`, `LineReadAdjustment`, `FileReadState` if still referenced).

- [ ] **Step 6: Typecheck + LOOP SUITE.** Expected: 0 fail (read-overlap assertions in `repo-search-loop.core.test.ts` + `tool-output-fit` interplay are the sharp edge).

- [ ] **Step 7: Commit**

```powershell
git add src/repo-search/engine.ts
git commit -m "refactor(repo-search): route output fitting and read-window state through classes"
```

### Task 19: Integrate `TerminalSynthesizer`

**Files:** Modify: `src/repo-search/engine.ts`

- [ ] **Step 1:** Replace the whole synthesis block (2124–2207, as renumbered) with:

```ts
if (!String(finalOutput || '').trim()) {
  const synthesizer = new TerminalSynthesizer({
    baseUrl: options.baseUrl,
    model: options.model,
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    config: options.config,
    useEstimatedTokensOnly,
    totalContextTokens: budget.totalContextTokens,
    thinkingEnabled: plannerThinkingEnabled,
    reasoningContentEnabled: plannerReasoningContentEnabled,
    preserveThinking: plannerPreserveThinkingEnabled,
    streamFinishAsAnswer,
    logger: options.logger || null,
    progress,
    tokenUsage,
  });
  const synthesis = await synthesizer.synthesize({
    taskId: task.id,
    question: task.question,
    reason,
    transcript: transcript.renderTail(2),
    turnsUsed,
    mockResponses: options.mockResponses,
    mockResponseIndex,
  });
  finalOutput = synthesis.finalOutput;
  mockResponseIndex = synthesis.nextMockResponseIndex;
}
```

Import `TerminalSynthesizer`; remove now-unused engine.ts imports (`requestTerminalSynthesis`, `buildTerminalSynthesisPrompt`, `countTokensWithFallback` if unused elsewhere).

- [ ] **Step 2: Typecheck + LOOP SUITE.** `repo-search-terminal-synthesis-retry.test.ts` is the direct lock. Expected: 0 fail.

- [ ] **Step 3: Commit**

```powershell
git add src/repo-search/engine.ts
git commit -m "refactor(repo-search): use TerminalSynthesizer for the synthesis fallback"
```

---

## Phase C — extract the remaining blocks and the orchestrator

### Task 20: `PromptPreparer` class

**Files:**
- Create: `src/repo-search/engine/prompt-preparer.ts`
- Modify: `src/repo-search/engine.ts`
- Test: `tests/engine-prompt-preparer.test.ts`

Moves the per-turn render → reserve-text → preflight → compaction-retry → overflow-throw block (engine.ts 998–1194 as renumbered). After Phase B this block already talks only to `transcript`, `budget`, `progress`, and `options.*` — the class captures those once.

- [ ] **Step 1: Write the failing test**

Create `tests/engine-prompt-preparer.test.ts` (estimated-tokens mode keeps it offline; the compaction path is already covered by LOOP SUITE, so unit scope = happy path + overflow throw):

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { ProgressReporter } from '../src/repo-search/engine/progress-reporter.js';
import { PromptPreparer } from '../src/repo-search/engine/prompt-preparer.js';
import { TranscriptManager } from '../src/repo-search/engine/transcript-manager.js';
import { TurnBudget } from '../src/repo-search/engine/turn-budget.js';
import { resolveRepoSearchPlannerToolDefinitions } from '../src/repo-search/planner-protocol.js';

function makePreparer(budget: TurnBudget, transcript: TranscriptManager): PromptPreparer {
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
    transcript,
    progress: new ProgressReporter({ onProgress: null, taskId: 't1', maxTurns: 45, taskStartedAt: Date.now() }),
    logger: null,
    timingRecorder: null,
  });
}

test('prepareTurn returns a token count and output budget for a small prompt', async () => {
  const transcript = new TranscriptManager({ systemPromptContent: 'SYSTEM', historyMessages: [], initialUserContent: 'short question' });
  const preparer = makePreparer(new TurnBudget({ totalContextTokens: 32_000, maxTurns: 45 }), transcript);
  const prepared = await preparer.prepareTurn(1);
  assert.ok(prepared.promptTokenCount > 0);
  assert.ok(prepared.maxOutputTokens > 0);
});

test('prepareTurn throws planner_preflight_overflow when even compaction cannot fit', async () => {
  const transcript = new TranscriptManager({
    systemPromptContent: 'S'.repeat(200_000), // system prompt alone overflows and is never dropped
    historyMessages: [],
    initialUserContent: 'question',
  });
  const preparer = makePreparer(new TurnBudget({ totalContextTokens: 9_000, maxTurns: 45 }), transcript);
  await assert.rejects(preparer.prepareTurn(1), /planner_preflight_overflow/u);
});
```

- [ ] **Step 2: Run it — verify it fails** (`npx tsx --test tests/engine-prompt-preparer.test.ts`). Expected: module not found.

- [ ] **Step 3: Implement `src/repo-search/engine/prompt-preparer.ts`**

Constructor stores the fields used by the block; `prepareTurn(turn: number): Promise<{ promptTokenCount: number; maxOutputTokens: number }>` is the moved block with these textual substitutions (everything else verbatim, including all logger kinds and the two-stage compaction retry):

- `options.config` → `this.options.config`; `useEstimatedTokensOnly` → `this.options.useEstimatedTokensOnly`
- `messages.map(...)` → `this.options.transcript.messageRoles()`; `renderTaskTranscript(messages)` → `this.options.transcript.render()`
- `messages.splice(...)` → `this.options.transcript.replaceWith(compacted.messages)`
- `totalContextTokens`/`thinkingBufferTokens` → `this.options.budget.totalContextTokens`/`.thinkingBufferTokens`
- progress calls → `this.options.progress.*` (same methods as Task 17)
- timing spans → `this.options.timingRecorder?.start(...)` (same span names: `repo.prompt.render`, `repo.prompt.preflight`, `repo.prompt.compact`)
- the trailing per-turn maxOutputTokens computation (`getDynamicMaxOutputTokens`) and overflow throw stay inside `prepareTurn`; return `{ promptTokenCount: preflight.promptTokenCount, maxOutputTokens }`.

Class skeleton:

```ts
import type { SiftConfig } from '../../config/index.js';
import { getDynamicMaxOutputTokens } from '../../lib/dynamic-output-cap.js';
import type { TemporaryTimingRecorder } from '../../lib/temporary-timing-recorder.js';
import {
  buildPlannerRequestPromptReserveText,
  resolveRepoSearchPlannerToolDefinitions,
} from '../planner-protocol.js';
import { compactPlannerMessagesOnce, preflightPlannerPromptBudget } from '../prompt-budget.js';
import type { JsonLogger } from '../types.js';
import { ProgressReporter } from './progress-reporter.js';
import { TranscriptManager } from './transcript-manager.js';
import { TurnBudget } from './turn-budget.js';

export class PromptPreparer {
  constructor(private readonly options: {
    taskId: string;
    model: string;
    config: SiftConfig | undefined;
    useEstimatedTokensOnly: boolean;
    budget: TurnBudget;
    plannerToolDefinitions: ReturnType<typeof resolveRepoSearchPlannerToolDefinitions>;
    thinkingEnabled: boolean;
    reasoningContentEnabled: boolean;
    preserveThinking: boolean;
    transcript: TranscriptManager;
    progress: ProgressReporter;
    logger: JsonLogger | null;
    timingRecorder: TemporaryTimingRecorder | null;
  }) {}

  async prepareTurn(turn: number): Promise<{ promptTokenCount: number; maxOutputTokens: number }> {
    // moved block from engine.ts (Phase B state), with the substitutions listed above
  }
}
```

- [ ] **Step 4: Swap into `runTaskLoop`** — replace the moved block with:

```ts
const prepared = await promptPreparer.prepareTurn(turn);
```

constructing `promptPreparer` once before the turn loop. Downstream uses `prepared.promptTokenCount` (was `preflight.promptTokenCount`) and `prepared.maxOutputTokens`.

- [ ] **Step 5: Add `"tests/engine-prompt-preparer.test.ts"` to `tsconfig.test.json`; typecheck + unit test + LOOP SUITE.** Expected: 0 fail.

- [ ] **Step 6: Commit**

```powershell
git add src/repo-search/engine/prompt-preparer.ts src/repo-search/engine.ts tests/engine-prompt-preparer.test.ts tsconfig.test.json
git commit -m "refactor(repo-search): extract per-turn prompt preparation into PromptPreparer"
```

### Task 21: `TaskLoop` orchestrator class

**Files:**
- Create: `src/repo-search/engine/task-loop.ts`
- Modify: `src/repo-search/engine.ts`

After Tasks 14–20 the remaining `runTaskLoop` body is the turn loop + tool-action processing (~500 lines) whose state is mostly class instances. Move it wholesale into a class — this is a mechanical relocation, not a redesign; the LOOP SUITE is the gate.

- [ ] **Step 1: Create `src/repo-search/engine/task-loop.ts`** with this shape:

```ts
export class TaskLoop {
  // one readonly field per current local: task, options-derived scalars (maxTurns,
  // maxInvalidResponses, minToolCallsBeforeFinish, loopKind, streamFinishAsAnswer,
  // planner flags, allowedPlannerToolNames, plannerToolDefinitions, slotId,
  // ignorePolicy, bootstrapFileList, historicalToolStats, webTools,
  // chatWebGroundingPolicy), and the Phase A/B/C instances (budget, tokenUsage,
  // toolStats, duplicates, forcedFinish, progress, transcript, resultBudgeter,
  // readWindows, promptPreparer).
  // Mutable loop state stays as private fields: commands, turnThinking, finalOutput,
  // invalidResponses, commandFailures, safetyRejects, reason, turnsUsed,
  // mockResponseIndex, progressToolCallSeq, recentEvidenceKeys, successfulToolCalls,
  // forcedFinishCountdownUserMessageIndex.

  constructor(task: TaskDefinition, options: RunTaskLoopOptions) {
    // move the setup section (current lines between `const taskStartedAt = ...` and
    // the `for (let turn = 1 ...)` header) here verbatim, assigning to fields.
  }

  async run(): Promise<TaskResult> {
    for (let turn = 1; turn <= this.maxTurns; turn += 1) {
      const outcome = await this.runTurn(turn);
      if (outcome === 'stop') break;
    }
    return this.buildResult();
  }

  private async runTurn(turn: number): Promise<'continue' | 'stop'> {
    // current per-turn body up to and including the action parse + finish handling.
    // `continue`/`break` statements become return 'continue' / return 'stop'.
  }

  private async handleFinishAction(turn: number, action: ..., response: ...): Promise<'continue' | 'stop'> {
    // current finish branch (finish evaluation + grounding rejection + accept)
  }

  private async executeToolActions(turn: number, toolActions: ..., response: ..., promptTokenCount: number): Promise<'continue' | 'stop'> {
    // current `for (const toolAction of toolActions)` loop + batch append tail
  }

  private async buildResult(): Promise<TaskResult> {
    // current post-loop tail: TerminalSynthesizer fallback, signal evaluation,
    // task_done log, TaskResult literal.
  }
}
```

Move the helper functions that only the loop uses (`buildAssistantReplayMessage`, `buildAssistantToolCallMessage`, `buildInvalidToolCallActionFromResponseText`, `isPlannerReasoning*`, `allocateLlamaCppSlotId` + `nextLlamaCppSlotId`, `buildWebToolsForTaskLoop`, `DEFAULT_ENGINE_WEB_SEARCH_CONFIG`, constants `DEFAULT_MAX_TURNS`, `DEFAULT_MAX_INVALID_RESPONSES`, `DEFAULT_TIMEOUT_MS`, `MIN_TOOL_CALLS_BEFORE_FINISH`) into `task-loop.ts`, exporting `DEFAULT_MAX_TURNS`, `DEFAULT_MAX_INVALID_RESPONSES`, `DEFAULT_TIMEOUT_MS` for `runRepoSearch`. Move `RunTaskLoopOptions` and export it. Splitting rule: every method ≤120 lines; if `executeToolActions` exceeds it, extract `private async processToolAction(...)` for the single-action body (validation → forced-finish gate → duplicate gate → execute → fit → record), keeping the per-batch accumulators (`batchOutcomes`, `pendingModeChangeUserMessages`, `pendingForcedFinishCountdownText`, `batchDuplicateAnchorIndex`, `acceptedToolPromptTokensThisTurn`) in a local `TurnBatchState` object typed at the top of the file and passed explicitly.

- [ ] **Step 2: Shrink `engine.ts`** — `runTaskLoop` becomes:

```ts
export async function runTaskLoop(task: TaskDefinition, options: RunTaskLoopOptions): Promise<TaskResult> {
  return new TaskLoop(task, options).run();
}
```

Dependency direction is one-way and non-negotiable: **`engine.ts` → `task-loop.ts`; `task-loop.ts` never imports from `engine.ts`.** Concretely:

- **Move into `task-loop.ts`:** `TaskDefinition`, `TaskResult`, `RunTaskLoopOptions` (exported here for the first time — it is currently a non-exported type at engine.ts:801), `evaluateTaskSignals`, and the `TaskLoop` class.
- **`engine.ts` keeps:** `TASK_PACK`, `Scorecard`, `buildScorecard`, `assertConfiguredModelPresent`, `runRepoSearch`, and the thin `runTaskLoop` wrapper above. It imports what it needs from `./engine/task-loop.js` and re-exports the moved names so its public surface is unchanged:

```ts
export { evaluateTaskSignals, type RunTaskLoopOptions, type TaskDefinition, type TaskResult } from './engine/task-loop.js';
```

- **Barrel check:** `src/repo-search/index.ts` re-exports `assertConfiguredModelPresent`, `buildScorecard`, `runRepoSearch`, `runTaskLoop`, `TASK_PACK`, `type Scorecard`, `type TaskDefinition`, `type TaskResult` from `./engine.js` (index.ts:6–15). With the re-export line above, the barrel needs no edit — confirm with `npm run typecheck` that every barrel export still resolves.

- [ ] **Step 3: Typecheck + LOOP SUITE + grep guard**

```powershell
npm run typecheck:test
npx tsx --test tests/repo-search-loop.core.test.ts tests/mock-repo-search-loop.test.ts tests/repo-search.test.ts tests/repo-search-terminal-synthesis-retry.test.ts tests/repo-search-logging.test.ts tests/tool-command-display.test.ts tests/repo-search-chat-loop.test.ts tests/repo-search-chat-execute.test.ts tests/repo-search-planner-empty-tools.test.ts
```

Expected: 0 fail. Also verify no consumer broke: `rg -n "from '../repo-search/engine" src tests scripts` — every hit must still resolve (they import from `engine.ts`, whose exports are unchanged).

- [ ] **Step 4: Commit**

```powershell
git add -A src tests
git commit -m "refactor(repo-search): move task loop into TaskLoop orchestrator class"
```

### Task 22: Final verification + size gates

**Files:** none new.

- [ ] **Step 1: Full suite**

```powershell
npm test
```

Expected: same pass/fail set as the Task 1 baseline (the suite includes pre-existing unrelated failures only if they were failing at baseline — compare against the Task 1 output).

- [ ] **Step 2: Branch coverage on the new engine classes**

```powershell
npx c8 --include="src/repo-search/engine/**" --exclude="src/repo-search/engine/read-overlap.ts" --reporter=text npx tsx --test tests/engine-command-execution.test.ts tests/engine-native-tools.test.ts tests/engine-turn-budget.test.ts tests/engine-token-usage.test.ts tests/engine-tool-stats.test.ts tests/engine-duplicate-tracker.test.ts tests/engine-forced-finish.test.ts tests/engine-progress-reporter.test.ts tests/engine-transcript-manager.test.ts tests/engine-tool-result-budgeter.test.ts tests/engine-read-window-governor.test.ts tests/engine-terminal-synthesizer.test.ts tests/engine-prompt-preparer.test.ts
```

Expected: ≥95% branch coverage for each newly *authored* class file (`turn-budget.ts`, `token-usage.ts`, `tool-stats.ts`, `duplicate-tracker.ts`, `forced-finish.ts`, `progress-reporter.ts`, `transcript-manager.ts`, `tool-result-budgeter.ts`, `read-window-governor.ts`, `terminal-synthesizer.ts`). **Documented exceptions** (moved-only code whose deep branches are exercised by the LOOP SUITE, not unit tests): `abort.ts`, `command-execution.ts`, `native-tools.ts`, `prompt-preparer.ts`, `task-loop.ts`. For any authored file below 95%, either add the missing unit case or record a one-line justification in the final commit message. (`read-overlap.ts` predates this plan and is excluded.)

- [ ] **Step 3: Size gates**

```powershell
(Get-Content src\repo-search\engine.ts | Measure-Object -Line).Lines
(Get-Content src\repo-search\engine\task-loop.ts | Measure-Object -Line).Lines
```

Expected: `engine.ts` < 450 lines; `task-loop.ts` < 900 lines with no method > 120 lines (spot-check `runTurn`, `executeToolActions`). If a gate fails, extract further per the Task 21 splitting rule before proceeding.

- [ ] **Step 4: Dead-code sweep**

```powershell
rg -n "modelPromptTokens|toolStatsByType|zeroOutputStreak|duplicateReplay|lastLoggedMessageCount|writeRedConsoleLine|fileReadStateByPath|fileReadCountByPath" src/repo-search/engine.ts
```

Expected: no matches (all replaced by classes). Any hit = an incomplete swap; fix it.

- [ ] **Step 5: Update `ARCHITECTURE-REVIEW.md`** — mark F1 as addressed with a one-line note pointing at `src/repo-search/engine/` and this plan file.

- [ ] **Step 6: Commit**

```powershell
git add -A
git commit -m "refactor(repo-search): finalize F1 runTaskLoop decomposition; engine.ts under 450 lines"
```

---

## Self-review notes (already applied)

- **Order matters:** Tasks 14–19 each leave `runTaskLoop` compiling and green; do not reorder Phase B after Task 17 (Tasks 18–19 reference `transcript`/`progress`).
- **Names are consistent across tasks:** `tokenUsage`, `budget`, `toolStats`, `duplicates`, `forcedFinish`, `progress`, `transcript`, `resultBudgeter`, `readWindows`, `promptPreparer` — use these exact instance names so later task diffs apply cleanly.
- **Known judgment points for the executor** (verify, don't guess): exact `RepoSearchProgressEvent` union field optionality (Task 9 Step 3 note), `requestTerminalSynthesis` mock semantics (Task 13 preamble), `ChatMessage.tool_call_id` typing (Task 10 note).
- **What this plan deliberately does NOT do:** change any prompt text, gate logic (L2's inverted finish gate ships as-is), sampling, or protocol behavior — those are separate findings (Part 2 of the review) and belong in their own plans on top of this structure.




