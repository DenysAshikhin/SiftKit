# repo-agent Operation Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class `repo-agent` operation mode — a repository coding agent with the full read + mutate tool surface (`write`/`edit`/`run`), human approval on by default (`--no-approval` to opt out), and a pi.dev-style agentic system prompt — on CLI + web.

**Architecture:** Reuse the entire repo-search execution stack (task-loop, approval gate, streamed SSE endpoint, CLI streamed transport). A behavioral discriminant `taskKind: 'repo-agent'` on `RepoSearchExecutionRequest` selects the agent system prompt and finish options; everything downstream (metrics bucket, DB runKind, executor lock, approval endpoint) is shared with `repo-search`. The server route `POST /repo-agent` and CLI command `repo-agent` are thin siblings of the search route/command, differing only by an explicit `mode: 'search' | 'agent'` data discriminant — no dynamically-passed functions.

**Tech Stack:** TypeScript (strict, zero-cast), Zod runtime schemas in `@siftkit/contracts`, `node:test` + `assert/strict`, existing SSE harness (`tests/helpers/streamed-op-harness.js`, `tests/helpers/sse-http.js`).

**Key design resolutions (locked before implementation):**
1. **Metrics taskKind:** `repo-agent` maps to the `repo-search` metric bucket + `repo_search` DB runKind + `repo_search` lock. Only the behavioral discriminant is new. `TaskMetricKind` in contracts is **unchanged**.
2. **Approval endpoint:** shared `/repo-search/approval` (keyed by globally-unique `requestId`). No `/repo-agent/approval` route.
3. **Agent tool list in the prompt:** written as a static concise list in `buildAgentSystemPrompt`, not dynamically sourced from `REPO_TOOL_REGISTRY`, to avoid an import cycle (`planner-protocol.ts` ↔ `prompts.ts`) and dynamic coupling.
4. **CLI TTY assertion:** generalize the existing `assertInteractiveStdinIsTty` into a reusable `assertStdinIsTty(required, stdin, context)` so both `--interactive` (search) and approval-on (agent) share one implementation with a context-specific message.

---

## File Structure

**Contracts**
- Modify: `packages/contracts/src/config.ts` — add `write`/`edit`/`run` to `PresetToolNameSchema`; add `repo-agent` to `PresetKindSchema`.

**Presets**
- Modify: `src/presets.ts` — `REPO_AGENT_TOOLS`, populate `full` default, extend `PresetKind`/`isPresetKind`/`getOperationModeFromRecord`/`normalizeUserPreset`, add builtin `repo-agent` preset.

**Agent prompt**
- Modify: `src/repo-search/prompts.ts` — new `buildAgentSystemPrompt`.

**Execute**
- Modify: `src/repo-search/types.ts` — `RepoSearchExecutionRequest.taskKind` gains `'repo-agent'`.
- Modify: `src/repo-search/execute.ts` — `isAgent` branch selecting agent prompt + finish options.

**Server**
- Modify: `src/status-server/routes/core.ts` — extract `RepoTaskEndpoint` base with `mode` discriminant; `RepoSearchEndpoint`/`RepoAgentEndpoint` subclasses; register `POST /repo-agent`.

**CLI**
- Modify: `src/cli/args.ts` — `repo-agent` command wiring, `REPO_AGENT_SYNOPSIS`, `validateRepoAgentTokens`, `--no-approval` → `noApproval`.
- Modify: `src/cli/run-repo-search.ts` — generalize TTY assertion into `assertStdinIsTty`; add shared `runRepoTaskCli`; keep `runRepoSearchCli` as a thin wrapper.
- Create: `src/cli/run-repo-agent.ts` — thin `runRepoAgentCli` over the shared runner.
- Modify: `src/cli/status-server-api-client.ts` — `requestRepoAgent`.
- Modify: `src/cli/dispatch.ts` — `repo-agent` command branch + TTY fast-fail.
- Modify: `src/cli/help.ts` — list `repo-agent`.

**Tests** — see each task.

---

## Task 1: Contracts — widen tool + kind enums

**Files:**
- Modify: `packages/contracts/src/config.ts:117-128`
- Test: `packages/contracts/**` (add a test file if the package has a test runner) OR assert via `tests/config-normalization.test.ts`. This repo validates contracts through consumers; use `tests/presets.test.ts` (Task 2) for enum coverage. This task is a pure schema widening — verified by the Task 2 tests that accept the new values. **No standalone test step; Task 2's failing tests drive it.**

- [ ] **Step 1: Widen `PresetToolNameSchema`**

In `packages/contracts/src/config.ts`, change:

```ts
export const PresetToolNameSchema = z.enum([
  'find_text', 'read_lines', 'json_filter', 'json_get',
  'read', 'grep', 'find', 'ls', 'git',
  'web_search', 'web_fetch',
  'write', 'edit', 'run',
]);
```

- [ ] **Step 2: Widen `PresetKindSchema`**

```ts
export const PresetKindSchema = z.enum(['summary', 'chat', 'plan', 'repo-search', 'repo-agent']);
```

- [ ] **Step 3: Typecheck the contracts package**

Run: `npm run -w @siftkit/contracts build` (or the repo's typecheck: `npm run typecheck`)
Expected: PASS (schemas are the single source; `SiftPresetSchema`/`OperationModeAllowedToolsSchema` derive automatically).

- [ ] **Step 4: Commit**

```bash
git add packages/contracts/src/config.ts
git commit -m "feat(contracts): allow write/edit/run tools and repo-agent preset kind"
```

---

## Task 2: Presets — REPO_AGENT_TOOLS, full default, builtin preset, kind defaulting

**Files:**
- Modify: `src/presets.ts`
- Test: `tests/presets.test.ts`, `tests/config-normalization.test.ts`

- [ ] **Step 1: Update the builtin-preset expectation tests (write the failing assertions)**

In `tests/presets.test.ts`, update the `builtin presets are present and not deletable` test to include `repo-agent` (append it last):

```ts
  assert.deepEqual(
    presets.map((preset) => preset.id),
    ['summary', 'repo-search', 'chat', 'plan', 'repo-agent'],
  );
  assert.deepEqual(
    presets.map((preset) => [preset.id, preset.presetKind, preset.operationMode]),
    [
      ['summary', 'summary', 'summary'],
      ['repo-search', 'repo-search', 'read-only'],
      ['chat', 'chat', 'summary'],
      ['plan', 'plan', 'read-only'],
      ['repo-agent', 'repo-agent', 'full'],
    ],
  );
```

Add a focused assertion block at the end of the same test:

```ts
  const agent = presets.find((preset) => preset.id === 'repo-agent');
  assert.ok(agent);
  assert.deepEqual(agent.allowedTools, ['read', 'grep', 'find', 'ls', 'git', 'web_search', 'web_fetch', 'write', 'edit', 'run']);
  assert.deepEqual(agent.surfaces, ['cli', 'web']);
  assert.equal(agent.operationMode, 'full');
  assert.equal(agent.repoRootRequired, true);
  assert.equal(agent.useForSummary, false);
  assert.equal(agent.maxTurns, 80);
```

Update the `preset surface filtering` test expectations to include `repo-agent` (present on both surfaces, appended after the builtins in insertion order):

```ts
  assert.deepEqual(
    getPresetsForSurface(presets, 'cli').map((preset) => preset.id),
    ['summary', 'repo-search', 'repo-agent', 'dual-surface'],
  );
  assert.deepEqual(
    getPresetsForSurface(presets, 'web').map((preset) => preset.id),
    ['repo-search', 'plan', 'repo-agent', 'dual-surface'],
  );
```

Update the `config persistence stores normalized presets in sqlite` test's `OperationModeAllowedTools` expectation:

```ts
    assert.deepEqual(loaded.OperationModeAllowedTools, {
      summary: ['find_text', 'read_lines', 'json_filter', 'json_get'],
      'read-only': [...REPO_SEARCH_TOOLS],
      full: ['read', 'grep', 'find', 'ls', 'git', 'web_search', 'web_fetch', 'write', 'edit', 'run'],
    });
```

Add a new test for user-preset defaulting of the `repo-agent` kind:

```ts
test('user preset with repo-agent kind defaults to full mode and repoRootRequired', () => {
  const presets = normalizePresets([
    { id: 'my-agent', label: 'My Agent', presetKind: 'repo-agent' },
  ]);
  const found = findPresetById(presets, 'my-agent');
  assert.ok(found);
  assert.equal(found.presetKind, 'repo-agent');
  assert.equal(found.operationMode, 'full');
  assert.equal(found.repoRootRequired, true);
  assert.deepEqual(found.allowedTools, ['read', 'grep', 'find', 'ls', 'git', 'web_search', 'web_fetch', 'write', 'edit', 'run']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/presets.test.ts`
Expected: FAIL — builtin list missing `repo-agent`; `full` default is `[]`; `repo-agent` kind not recognized.

- [ ] **Step 3: Add `REPO_AGENT_TOOLS` and populate the `full` default**

In `src/presets.ts`, after the `WEB_RESEARCH_TOOLS` / `READ_ONLY_TOOLS` block (near line 19), add:

```ts
export const REPO_AGENT_TOOLS = ['read', 'grep', 'find', 'ls', 'git', 'web_search', 'web_fetch', 'write', 'edit', 'run'] as const;
REPO_AGENT_TOOLS satisfies readonly PresetToolName[];
```

Change `DEFAULT_OPERATION_MODE_ALLOWED_TOOLS` (line 52-56):

```ts
const DEFAULT_OPERATION_MODE_ALLOWED_TOOLS: OperationModeAllowedTools = {
  summary: [...SUMMARY_TOOLS],
  'read-only': [...READ_ONLY_TOOLS],
  full: [...REPO_AGENT_TOOLS],
};
```

- [ ] **Step 4: Extend the `PresetKind` union and `isPresetKind`**

Change the type alias (line 7):

```ts
export type PresetKind = 'summary' | 'chat' | 'plan' | 'repo-search' | 'repo-agent';
```

Change `isPresetKind` (line 70-72):

```ts
export function isPresetKind(value: OptionalJsonValue): value is PresetKind {
  return value === 'summary' || value === 'chat' || value === 'plan' || value === 'repo-search' || value === 'repo-agent';
}
```

- [ ] **Step 5: Default operationMode + repoRootRequired for the `repo-agent` kind**

In `getOperationModeFromRecord` (line 132-147), add the `repo-agent → full` branch before the final fallback:

```ts
  if (presetKind === 'plan' || presetKind === 'repo-search') {
    return 'read-only';
  }
  if (presetKind === 'repo-agent') {
    return 'full';
  }
  return fallback;
```

In `normalizeUserPreset` (line 293-312), update the operationMode fallback, repoRootRequired default, and maxTurns default so `repo-agent` mirrors the plan/repo-search branches with `full` mode:

```ts
  const presetKind = getPresetKindFromRecord(record, 'summary');
  const operationMode = getOperationModeFromRecord(
    record,
    presetKind === 'repo-agent' ? 'full' : (presetKind === 'plan' || presetKind === 'repo-search' ? 'read-only' : 'summary'),
    presetKind,
  );
```

and, in the same `buildPreset({...})` call:

```ts
    surfaces: normalizeSurfaceList(reader.value('surfaces'), presetKind === 'summary' ? ['cli'] : ['web']),
    ...
    repoRootRequired: reader.value('repoRootRequired') === undefined
      ? (presetKind === 'plan' || presetKind === 'repo-search' || presetKind === 'repo-agent')
      : Boolean(reader.value('repoRootRequired')),
    maxTurns: normalizeNullableInteger(
      reader.value('maxTurns'),
      presetKind === 'repo-agent' ? 80 : (presetKind === 'plan' || presetKind === 'repo-search' ? 45 : null),
    ),
```

- [ ] **Step 6: Add the builtin `repo-agent` preset**

In `BUILTIN_PRESETS` (after the `plan` preset, before the closing `] as const`, line 254):

```ts
  buildPreset({
    id: 'repo-agent',
    label: 'Repo Agent',
    description: 'Interactive repository coding agent that reads, searches, edits, writes, and runs commands with human approval.',
    presetKind: 'repo-agent',
    operationMode: 'full',
    promptPrefix: '',
    allowedTools: [...REPO_AGENT_TOOLS],
    surfaces: ['cli', 'web'],
    useForSummary: false,
    builtin: true,
    deletable: false,
    includeAgentsMd: true,
    includeRepoFileListing: true,
    repoRootRequired: true,
    maxTurns: 80,
  }),
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test tests/presets.test.ts tests/config-normalization.test.ts`
Expected: PASS.

- [ ] **Step 8: Sweep for other `full: []` / builtin-list assertions**

Run: `node --test tests/dashboard-presets.test.ts tests/preset-editor.test.ts tests/preset-execution.test.ts tests/dashboard-managed-presets.test.ts`
Expected: If any assert `full: []` or enumerate builtin ids, update them the same way (add `repo-agent`, set `full` to `REPO_AGENT_TOOLS`). Fix inline, re-run until PASS.

- [ ] **Step 9: Commit**

```bash
git add src/presets.ts tests/presets.test.ts tests/config-normalization.test.ts
git commit -m "feat(presets): add builtin repo-agent preset and full-mode tool defaults"
```

---

## Task 3: Agent system prompt

**Files:**
- Modify: `src/repo-search/prompts.ts`
- Test: `tests/repo-search-prompts.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/repo-search-prompts.test.ts`:

```ts
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
```

Ensure the test file imports `buildAgentSystemPrompt` from `../src/repo-search/prompts.js` and has `fs`, `os`, `path` imported (add any missing imports at the top).

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/repo-search-prompts.test.ts`
Expected: FAIL — `buildAgentSystemPrompt is not a function`.

- [ ] **Step 3: Implement `buildAgentSystemPrompt`**

In `src/repo-search/prompts.ts`, immediately after `buildTaskSystemPrompt` (after line 277), add:

```ts
export function buildAgentSystemPrompt(repoRoot: string, options?: {
  includeAgentsMd?: boolean;
  includeRepoFileListing?: boolean;
}): string {
  const agentsContent = options?.includeAgentsMd === false ? '' : readAgentsMd(repoRoot);
  const startupScanLine = options?.includeRepoFileListing === false
    ? '- No startup file listing provided — use grep/find/ls to discover where to work.'
    : '- A repository file listing is provided in the user message; use it to locate files.';
  return [
    'You are an expert coding assistant operating inside SiftKit, a repository coding agent.',
    'You help by reading files, searching the repository, editing code, writing new files, and running commands.',
    '',
    'Return ONE valid JSON object per turn — no markdown fences.',
    'Action shape: {"action":"<tool>", ...args}. For independent read-only lookups, use one {"action":"tool_batch","calls":[...]}.',
    'Finish when the task is complete: {"action":"finish","output":"<concise summary of what changed and any follow-ups>"}.',
    '',
    'Available tools:',
    '- read: read a file (line-numbered; use offset/limit for large files).',
    '- grep: search file contents by pattern.',
    '- find: locate files by glob.',
    '- ls: list a directory one level deep.',
    '- git: run ONE read-only git command (status/log/show/blame). Mutating git is rejected.',
    '- web_search / web_fetch: consult the public web only when external/current info is needed.',
    '- write: create a file or fully overwrite one (creates parent dirs).',
    '- edit: exact-text replacement in an existing file; each oldText must match a unique, non-overlapping region.',
    '- run: execute a shell command in the repository root; returns stdout and stderr.',
    '',
    'Guidelines:',
    '- Be concise. Show file paths clearly when working with files.',
    '- Prefer `edit` (exact replacement) over `write` for existing files; use `write` only for new files or full rewrites.',
    '- Read a file before editing it; re-read after large edits to confirm the result.',
    '- Use `run` to verify changes (build, tests, lint) whenever a relevant check exists.',
    '- `git` is read-only here; staging and committing are not your job unless the task explicitly asks.',
    '- Finish with a short summary of what changed and any follow-ups — plain prose, not file:line anchor bullets.',
    startupScanLine,
    ...(agentsContent ? ['', '--- agents.md (project-specific instructions) ---', '', agentsContent] : []),
  ].join('\n');
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/repo-search-prompts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/repo-search/prompts.ts tests/repo-search-prompts.test.ts
git commit -m "feat(repo-search): add pi-style agent system prompt builder"
```

---

## Task 4: Execute — repo-agent behavioral branch

**Files:**
- Modify: `src/repo-search/types.ts:58`
- Modify: `src/repo-search/execute.ts:22-30` (imports), `250-254` (taskKind derivation), `313-338` (runRepoSearch options)
- Test: `tests/repo-search-agent-execute.test.ts` (new)

- [ ] **Step 1: Widen the request type**

In `src/repo-search/types.ts`, change line 58:

```ts
  taskKind?: 'plan' | 'repo-search' | 'chat' | 'repo-agent';
```

- [ ] **Step 2: Write the failing E2E test**

Create `tests/repo-search-agent-execute.test.ts` (mirrors `tests/repo-search-chat-execute.test.ts` structure — inspect that file for the exact harness/imports if the snippet below drifts):

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeRepoSearchRequest } from '../src/repo-search/index.js';
import { INTERACTIVE_REPO_TOOL_NAMES } from '../src/repo-search/planner-protocol.js';

test('repo-agent taskKind runs the agent prompt and applies a write without approval gate', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-agent-exec-'));
  try {
    const result = await executeRepoSearchRequest({
      taskKind: 'repo-agent',
      prompt: 'create out.txt',
      repoRoot: dir,
      model: 'mock-model',
      maxTurns: 4,
      includeAgentsMd: false,
      includeRepoFileListing: true,
      allowedTools: [...INTERACTIVE_REPO_TOOL_NAMES],
      availableModels: ['mock-model'],
      mockResponses: [
        '{"action":"write","path":"out.txt","content":"agent wrote this"}',
        '{"action":"finish","output":"created out.txt"}',
      ],
      mockCommandResults: {},
    });
    assert.equal(result.scorecard.verdict === 'fail', false);
    assert.equal(fs.readFileSync(path.join(dir, 'out.txt'), 'utf8'), 'agent wrote this');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --test tests/repo-search-agent-execute.test.ts`
Expected: FAIL — with `taskKind: 'repo-agent'`, `execute.ts` currently falls into the `repo-search` search-discipline prompt (min-turn finish gate / wrong persona) rather than the agent path; the single write+finish may be rejected or mis-prompted.

- [ ] **Step 4: Add the agent branch to `execute.ts`**

Add the import (in the block ending line 30, alongside the other repo-search imports):

```ts
import { buildAgentSystemPrompt } from './prompts.js';
```

Change the `taskKind` derivation (lines 250-254) to also compute `isAgent`:

```ts
  const isAgent = request.taskKind === 'repo-agent';
  const taskKind = request.taskKind === 'plan'
    ? 'plan'
    : request.taskKind === 'chat'
      ? 'chat'
      : 'repo-search';
```

Change the `runRepoSearch({...})` option block (lines 321-327) to:

```ts
      allowEmptyTools: taskKind === 'chat',
      loopKind: taskKind === 'chat' ? 'chat' : 'repo-search',
      streamFinishAsAnswer: taskKind === 'chat',
      minToolCallsBeforeFinish: (taskKind === 'chat' || isAgent) ? 0 : undefined,
      systemPromptOverride: isAgent
        ? buildAgentSystemPrompt(repoRoot, {
            includeAgentsMd: request.includeAgentsMd,
            includeRepoFileListing: request.includeRepoFileListing,
          })
        : (taskKind === 'chat' ? (request.systemPrompt || '') : undefined),
      historyMessages: taskKind === 'chat' ? (request.history || []) : undefined,
      thinkingEnabledOverride: taskKind === 'chat' ? (request.thinkingEnabled !== false) : undefined,
```

> Rationale: `taskKind` stays within the metrics union (`repo-agent` buckets under `repo-search`, matching the shared DB runKind + lock). `isAgent` is the sole behavioral switch: agent prompt + `minToolCallsBeforeFinish: 0` (so a single edit→finish is allowed). `loopKind: 'repo-search'` is safe — `evaluateFinishAttempt` only blocks anchor-bearing outputs with exactly one supporting call; a prose change-summary passes.

- [ ] **Step 5: Run to verify it passes**

Run: `node --test tests/repo-search-agent-execute.test.ts`
Expected: PASS.

- [ ] **Step 6: Regression — chat + repo-search execute paths unchanged**

Run: `node --test tests/repo-search-chat-execute.test.ts tests/repo-search.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/repo-search/types.ts src/repo-search/execute.ts tests/repo-search-agent-execute.test.ts
git commit -m "feat(repo-search): route repo-agent taskKind to the agent prompt and finish options"
```

---

## Task 5: Server — RepoTaskEndpoint base, RepoAgentEndpoint, POST /repo-agent

**Files:**
- Modify: `src/status-server/routes/core.ts:837-915` (endpoint classes), `1743-1761` (route table)
- Test: `tests/streamed-repo-agent-endpoint.test.ts` (new)

- [ ] **Step 1: Write the failing server E2E test**

Create `tests/streamed-repo-agent-endpoint.test.ts` (mirror `tests/streamed-repo-search-interactive.test.ts` — reuse its `postJson` helper and harness imports verbatim):

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { requestSse } from './helpers/sse-http.js';
import { startHarness } from './helpers/streamed-op-harness.js';
import { parseJsonValueText } from '../src/lib/json.js';
import { asObject } from './helpers/dashboard-http.js';
import type { JsonObject, JsonSerializable } from '../src/lib/json-types.js';

function postJson(url: string, body: JsonSerializable): Promise<{ statusCode: number; body: JsonObject }> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const request = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text, 'utf8') },
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { raw += chunk; });
      response.on('end', () => resolve({ statusCode: response.statusCode || 0, body: asObject(parseJsonValueText(raw || '{}')) }));
    });
    request.on('error', reject);
    request.write(text);
    request.end();
  });
}

test('POST /repo-agent (approval on): approves a write via the shared /repo-search/approval endpoint', async () => {
  const harness = await startHarness('siftkit-repo-agent-approve-');
  try {
    const response = await requestSse(`${harness.baseUrl}/repo-agent`, {
      body: {
        prompt: 'write a file', repoRoot: process.cwd(), model: 'mock-model', maxTurns: 4,
        availableModels: ['mock-model'],
        mockResponses: [
          '{"action":"write","path":"agent-endpoint-out.txt","content":"approved"}',
          '{"action":"finish","output":"wrote it"}',
        ],
        mockCommandResults: {},
      },
      timeoutMs: 20_000,
      onProgress: async (event) => {
        if (event.kind !== 'approval_request') return;
        const submitted = await postJson(`${harness.baseUrl}/repo-search/approval`, {
          requestId: String(event.requestId), approvalId: String(event.approvalId), decision: 'approve',
        });
        assert.equal(submitted.statusCode, 200);
      },
    });
    assert.ok(response.result, response.rawBody);
    const written = path.join(process.cwd(), 'agent-endpoint-out.txt');
    assert.equal(fs.readFileSync(written, 'utf8'), 'approved');
    fs.rmSync(written, { force: true });
    const approvalFrames = response.progress.filter((event) => event.kind === 'approval_request');
    assert.equal(approvalFrames.length, 1);
    assert.equal(approvalFrames[0].toolName, 'write');
  } finally {
    await harness.close();
  }
});

test('POST /repo-agent with approval:false runs autonomously with no approval frames', async () => {
  const harness = await startHarness('siftkit-repo-agent-auto-');
  try {
    const written = path.join(process.cwd(), 'agent-endpoint-auto.txt');
    const response = await requestSse(`${harness.baseUrl}/repo-agent`, {
      body: {
        prompt: 'write a file', repoRoot: process.cwd(), model: 'mock-model', maxTurns: 4,
        approval: false,
        availableModels: ['mock-model'],
        mockResponses: [
          '{"action":"write","path":"agent-endpoint-auto.txt","content":"auto"}',
          '{"action":"finish","output":"done"}',
        ],
        mockCommandResults: {},
      },
      timeoutMs: 20_000,
    });
    assert.ok(response.result, response.rawBody);
    assert.equal(fs.readFileSync(written, 'utf8'), 'auto');
    fs.rmSync(written, { force: true });
    assert.equal(response.progress.filter((event) => event.kind === 'approval_request').length, 0);
  } finally {
    await harness.close();
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/streamed-repo-agent-endpoint.test.ts`
Expected: FAIL — `POST /repo-agent` route does not exist (SSE error / 404).

- [ ] **Step 3: Extract `RepoTaskEndpoint` base and add `RepoAgentEndpoint`**

In `src/status-server/routes/core.ts`, replace the `RepoSearchEndpoint` class (lines 837-915) with an abstract base carrying the `mode` discriminant plus two concrete subclasses:

```ts
abstract class RepoTaskEndpoint extends StreamedOperationEndpoint<ParsedRepoSearchRoute> {
  protected readonly lockKind = 'repo_search';
  protected readonly taskKind = 'repo-search';
  protected abstract readonly mode: 'search' | 'agent';

  protected parseRequest(parsedBody: JsonObject): ParsedStreamedRequest<ParsedRepoSearchRoute> {
    const repoSearchRequest = parseRepoSearchRequest(parsedBody);
    if (!repoSearchRequest) {
      return { ok: false, error: 'Expected prompt.' };
    }
    const admission = createRepoSearchAdmissionRecord(repoSearchRequest);
    upsertRepoSearchAdmission(admission);
    return { ok: true, value: { parsedBody, repoSearchRequest, admission } };
  }

  protected onOperationFailed(parsed: ParsedRepoSearchRoute, errorMessage: string): void {
    markRepoSearchAdmissionFailed(parsed.admission, errorMessage);
  }

  protected async execute(
    ctx: ServerContext,
    parsed: ParsedRepoSearchRoute,
    stream: StreamedOperationContext,
  ): Promise<JsonSerializable> {
    const { parsedBody, repoSearchRequest, admission } = parsed;
    const reader = new JsonRecordReader(parsedBody);
    if (Number.isFinite(Number(parsedBody.simulateWorkMs)) && Number(parsedBody.simulateWorkMs) > 0) {
      await sleep(Math.max(1, Math.trunc(Number(parsedBody.simulateWorkMs))));
    }
    const config = readConfig(ctx.configPath);
    const interactive = parsedBody.interactive === true;
    const requestedAllowedTools = Array.isArray(parsedBody.allowedTools)
      ? parsedBody.allowedTools.map((value) => String(value))
      : undefined;
    // Agent always gets the full surface; approval is on unless approval===false.
    // Search keeps its existing interactive/sanitize logic.
    const approvalOn = this.mode === 'agent' ? parsedBody.approval !== false : interactive;
    const allowedTools = (this.mode === 'agent' || interactive)
      ? [...INTERACTIVE_REPO_TOOL_NAMES]
      : sanitizeNonInteractiveAllowedTools(requestedAllowedTools);
    const progressWriter = new LoggedRepoSearchSseProgressWriter(stream, admission.requestId);
    const approvalGate = approvalOn
      ? new ApprovalGate({
        requestId: admission.requestId,
        progressWriter,
        timeoutMs: readApprovalTimeoutMs(),
      })
      : undefined;
    if (approvalGate) {
      ctx.approvalGates.set(admission.requestId, approvalGate);
    }
    try {
      const result = await ctx.engineService.executeRepoSearch({
        taskKind: this.mode === 'agent' ? 'repo-agent' : 'repo-search',
        prompt: repoSearchRequest.prompt,
        requestId: admission.requestId,
        startedAtUtc: admission.startedAtUtc,
        promptPrefix: reader.optionalString('promptPrefix'),
        repoRoot: admission.repoRoot,
        statusBackendUrl: `${ctx.getServiceBaseUrl()}/status`,
        config,
        allowedTools,
        includeAgentsMd: resolveEffectiveAgentsMd(config, null),
        includeRepoFileListing: resolveEffectiveRepoFileListing(config, null),
        model: reader.optionalString('model'),
        maxTurns: reader.number('maxTurns') ?? undefined,
        logFile: reader.optionalString('logFile'),
        availableModels: Array.isArray(parsedBody.availableModels) ? parsedBody.availableModels.map((value) => String(value)) : undefined,
        mockResponses: Array.isArray(parsedBody.mockResponses) ? parsedBody.mockResponses.map((value) => String(value)) : undefined,
        mockCommandResults: normalizeRepoSearchMockCommandResults(parsedBody.mockCommandResults),
        abortSignal: stream.abortSignal,
        progressWriter,
        approvalGate,
      });
      RepoSearchResponseSanityChecker.assertSafeToSend(result);
      return result;
    } finally {
      if (approvalGate) {
        ctx.approvalGates.delete(admission.requestId);
      }
    }
  }
}

class RepoSearchEndpoint extends RepoTaskEndpoint {
  protected readonly mode = 'search';
}

class RepoAgentEndpoint extends RepoTaskEndpoint {
  protected readonly mode = 'agent';
}
```

> `taskKind = 'repo-search'` on the base is the `StreamedOperationEndpoint` metrics/lock tag (unchanged union). The `executeRepoSearch` call passes `'repo-agent'` for agent mode — that is the behavioral discriminant added in Task 4.

- [ ] **Step 4: Register the route**

In `CORE_ROUTES` (line 1752 area), add the agent route next to repo-search:

```ts
  { method: 'POST', path: '/repo-search/approval', endpoint: new RepoSearchApprovalEndpoint() },
  { method: 'POST', path: '/repo-search', endpoint: new RepoSearchEndpoint() },
  { method: 'POST', path: '/repo-agent', endpoint: new RepoAgentEndpoint() },
```

- [ ] **Step 5: Run to verify it passes**

Run: `node --test tests/streamed-repo-agent-endpoint.test.ts`
Expected: PASS.

- [ ] **Step 6: Regression — search endpoint + approval unchanged**

Run: `node --test tests/streamed-repo-search-interactive.test.ts tests/streamed-repo-search-endpoint.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/status-server/routes/core.ts tests/streamed-repo-agent-endpoint.test.ts
git commit -m "feat(server): add POST /repo-agent via shared RepoTaskEndpoint base"
```

---

## Task 6: API client — requestRepoAgent

**Files:**
- Modify: `src/cli/status-server-api-client.ts:86-99`
- Test: covered by Task 8's CLI E2E (the client is exercised end-to-end there). No standalone unit test — the streamed transport is integration-only in this repo.

- [ ] **Step 1: Add `requestRepoAgent` beside `requestRepoSearch`**

In `src/cli/status-server-api-client.ts`, after `requestRepoSearch` (line 99):

```ts
  requestRepoAgent(
    request: Record<string, JsonSerializable>,
    renderer: CliProgressRenderer,
    approvalPrompter?: CliApprovalPrompter,
  ): Promise<RepoSearchExecutionResult> {
    return this.requestStreamedOperation(
      '/repo-agent',
      JSON.stringify(request),
      RepoSearchExecutionResultSchema,
      renderer,
      'repo-search',
      approvalPrompter,
    );
  }
```

> The `'repo-search'` logged-task label and the `submitRepoSearchApproval` → `/repo-search/approval` path are shared intentionally (approval endpoint is keyed by `requestId`).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/cli/status-server-api-client.ts
git commit -m "feat(cli): add requestRepoAgent status-server client method"
```

---

## Task 7: CLI args — repo-agent command, --no-approval

**Files:**
- Modify: `src/cli/args.ts`
- Test: `tests/repo-search-cli.test.ts` (or the args-focused test file it uses — confirm where `validateRepoSearchTokens`/`parseArguments` are tested and colocate)

- [ ] **Step 1: Write failing arg tests**

Add to the args test file (search `tests/` for existing `validateRepoSearchTokens` / `parseArguments` coverage and append there):

```ts
test('validateRepoAgentTokens accepts value + boolean flags and rejects unknown', () => {
  assert.doesNotThrow(() => validateRepoAgentTokens(['--prompt', 'x', '--model', 'm', '--log-file', 'l', '--progress', '--no-approval']));
  assert.throws(() => validateRepoAgentTokens(['--prompt']), /Missing value for repo-agent option/u);
  assert.throws(() => validateRepoAgentTokens(['--interactive']), /Unknown option for repo-agent/u);
});

test('parseArguments maps --no-approval to noApproval', () => {
  assert.equal(parseArguments(['--prompt', 'x', '--no-approval']).noApproval, true);
  assert.equal(parseArguments(['--prompt', 'x']).noApproval, undefined);
});

test('repo-agent is a known, server-dependent command', () => {
  assert.equal(KNOWN_COMMANDS.has('repo-agent'), true);
  assert.equal(SERVER_DEPENDENT_COMMANDS.has('repo-agent'), true);
});
```

Ensure the test imports `validateRepoAgentTokens`, `KNOWN_COMMANDS`, `SERVER_DEPENDENT_COMMANDS`, `parseArguments` from `../src/cli/args.js`.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test <that test file>`
Expected: FAIL — `validateRepoAgentTokens` undefined; `repo-agent` not in the sets; `noApproval` unset.

- [ ] **Step 3: Add the command to the known/server-dependent sets**

In `src/cli/args.ts`, add `'repo-agent'` to `KNOWN_COMMANDS` (line 64) and `SERVER_DEPENDENT_COMMANDS` (line 84):

```ts
export const KNOWN_COMMANDS = new Set([
  'summary',
  'repo-search',
  'repo-agent',
  'preset',
  'run',
  'find-files',
  'internal',
]);
```

```ts
export const SERVER_DEPENDENT_COMMANDS = new Set([
  'summary',
  'preset',
  'install',
  'test',
  'eval',
  'config-get',
  'config-set',
  'capture-internal',
  'repo-search',
  'repo-agent',
]);
```

- [ ] **Step 4: Add the synopsis + `noApproval` field + validator + parse case**

Add the synopsis constant after `REPO_SEARCH_SYNOPSIS` (line 12):

```ts
export const REPO_AGENT_SYNOPSIS =
  'siftkit repo-agent --prompt "make change x" [--model <model>] [--log-file <path>] [--no-approval] [--progress]';
```

Add `noApproval` to `ParsedArgs` (after `interactive?: boolean;`, line 60):

```ts
  interactive?: boolean;
  noApproval?: boolean;
  progress?: boolean;
```

Add `validateRepoAgentTokens` after `validateRepoSearchTokens` (line 155):

```ts
export function validateRepoAgentTokens(tokens: string[]): void {
  const flagsWithValues = new Set(['--prompt', '-prompt', '--model', '--log-file']);
  const booleanFlags = new Set(['--no-approval', '--progress']);
  const helpFlags = new Set(['-h', '--h', '--help', '-help']);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (helpFlags.has(token)) {
      continue;
    }
    if (booleanFlags.has(token)) {
      continue;
    }
    if (flagsWithValues.has(token)) {
      if (tokens[index + 1] === undefined) {
        throw new Error(`Missing value for repo-agent option: ${token}`);
      }
      index += 1;
      continue;
    }
    if (token.startsWith('-')) {
      throw new Error(`Unknown option for repo-agent: ${token}`);
    }
  }
}
```

Add the parse case in `parseArguments`'s switch, right after the `--interactive` case (line 266):

```ts
      case '--no-approval':
        parsed.noApproval = true;
        break;
```

- [ ] **Step 5: Run to verify it passes**

Run: `node --test <that test file>`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/args.ts <that test file>
git commit -m "feat(cli): parse repo-agent command args and --no-approval"
```

---

## Task 8: CLI runner — shared runRepoTaskCli, runRepoAgentCli, dispatch, help

**Files:**
- Modify: `src/cli/run-repo-search.ts`
- Create: `src/cli/run-repo-agent.ts`
- Modify: `src/cli/dispatch.ts`
- Modify: `src/cli/help.ts`
- Test: `tests/repo-agent-cli.test.ts` (new), `tests/cli-help.test.ts`

- [ ] **Step 1: Write the failing CLI E2E test**

Create `tests/repo-agent-cli.test.ts`. Model it on the existing repo-search CLI E2E (`tests/repo-search-cli.test.ts` / `tests/repo-search-cli-interactive.test.ts`) — reuse their harness/mock-server setup. The two behaviors to assert:

```ts
// (imports + harness setup mirroring tests/repo-search-cli-interactive.test.ts)

test('repo-agent --no-approval runs autonomously (non-TTY) and applies a mutation', async () => {
  // Arrange a mock status server returning a scorecard for POST /repo-agent
  // (reuse the same mock-server helper the repo-search CLI tests use).
  // Run runCli / runRepoAgentCli with argv ['repo-agent','--prompt','make x','--no-approval']
  // and a non-TTY stdin.
  // Assert: exit code 0, no approval prompt written to stderr, request hit /repo-agent
  //         with approval:false in the body.
});

test('repo-agent without --no-approval on a non-TTY stdin fails fast with an approval-TTY error', async () => {
  // Run with argv ['repo-agent','--prompt','make x'] and stdin.isTTY !== true.
  // Assert: throws/returns error mentioning a TTY is required for approval mode;
  //         no network call is made.
});
```

> Follow the concrete harness in `tests/repo-search-cli-interactive.test.ts` for wiring the mock server, capturing the POST body, and driving `runCli`. Keep the two assertions above; fill in the setup by copying that file's scaffolding.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/repo-agent-cli.test.ts`
Expected: FAIL — `repo-agent` command unhandled in dispatch / `runRepoAgentCli` missing.

- [ ] **Step 3: Generalize the TTY assertion and add the shared runner**

In `src/cli/run-repo-search.ts`, replace `assertInteractiveStdinIsTty` with a reusable assertion plus a thin back-compat-free wrapper, and add `runRepoTaskCli`:

```ts
import { RepoSearchOutputFormatter } from '../repo-search/output-format.js';
import { CliApprovalPrompter } from './approval-prompter.js';
import { getCommandArgs, parseArguments, REPO_SEARCH_SYNOPSIS, REPO_AGENT_SYNOPSIS } from './args.js';
import { CliProgressRenderer } from './progress-renderer.js';
import { StatusServerApiClient } from './status-server-api-client.js';

/** A run that prompts for approval needs a real terminal to prompt on; refuse a non-TTY stdin. */
export function assertStdinIsTty(required: boolean, stdin: { isTTY?: boolean } | undefined, context: string): void {
  if (required && stdin?.isTTY !== true) {
    throw new Error(`${context} requires a TTY (stdin is not interactive).`);
  }
}

export type RepoTaskMode = 'search' | 'agent';

export async function runRepoTaskCli(options: {
  mode: RepoTaskMode;
  argv: string[];
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
}): Promise<number> {
  const tokens = getCommandArgs(options.argv);
  if (tokens.some((token) => token === '-h' || token === '--h' || token === '--help' || token === '-help')) {
    options.stdout.write(
      options.mode === 'agent'
        ? `Usage: ${REPO_AGENT_SYNOPSIS}\n`
          + 'Approval is on by default; every write/edit/run awaits your decision. --no-approval runs autonomously.\n'
          + '--progress streams per-turn telemetry to stderr.\n'
        : `Usage: ${REPO_SEARCH_SYNOPSIS}\n`
          + 'Shortcut: siftkit -prompt "find x y z in this repo"\n'
          + '--progress streams per-turn telemetry to stderr (off by default to keep captured output clean).\n',
    );
    return 0;
  }

  const parsed = parseArguments(tokens);
  const prompt = (parsed.prompt || parsed.question || parsed.positionals.join(' ')).trim();
  if (!prompt) {
    throw new Error(`A --prompt is required for repo-${options.mode === 'agent' ? 'agent' : 'search'}.`);
  }

  const stdin = options.stdin;
  const opLabel = options.mode === 'agent' ? 'repo-agent' : 'repo-search';
  const approvalOn = options.mode === 'agent' ? parsed.noApproval !== true : parsed.interactive === true;
  assertStdinIsTty(approvalOn, stdin, options.mode === 'agent' ? 'repo-agent approval mode' : '--interactive');
  const approvalPrompter = approvalOn && stdin
    ? new CliApprovalPrompter({ input: stdin, output: options.stderr })
    : undefined;
  const renderer = CliProgressRenderer.forCli(options.stderr, opLabel, parsed.progress === true);
  const client = new StatusServerApiClient();

  const response = options.mode === 'agent'
    ? await client.requestRepoAgent({
        prompt,
        repoRoot: process.cwd(),
        model: parsed.model,
        logFile: parsed.logFile,
        approval: parsed.noApproval !== true,
      }, renderer, approvalPrompter)
    : await client.requestRepoSearch({
        prompt,
        repoRoot: process.cwd(),
        model: parsed.model,
        logFile: parsed.logFile,
        interactive: parsed.interactive === true,
      }, renderer, approvalPrompter);

  const finalOutputs = response.scorecard.tasks
    .map((task) => task.finalOutput.trim())
    .filter((value) => value.length > 0);
  const formattedOutput = RepoSearchOutputFormatter.formatFinalOutputs(finalOutputs);
  if (formattedOutput) {
    options.stdout.write(`${formattedOutput}\n`);
    return 0;
  }
  options.stdout.write(`${JSON.stringify(response.scorecard, null, 2)}\n`);
  return 0;
}

export async function runRepoSearchCli(options: {
  argv: string[];
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
}): Promise<number> {
  return runRepoTaskCli({ mode: 'search', ...options });
}
```

> `parsed.model`/`parsed.logFile` are `string | undefined`; passing `undefined` into a `Record<string, JsonSerializable>` request object matches how `requestRepoSearch` is already called today.

- [ ] **Step 4: Add the thin agent entry point**

Create `src/cli/run-repo-agent.ts`:

```ts
import { runRepoTaskCli } from './run-repo-search.js';

export async function runRepoAgentCli(options: {
  argv: string[];
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
}): Promise<number> {
  return runRepoTaskCli({ mode: 'agent', ...options });
}
```

- [ ] **Step 5: Wire dispatch**

In `src/cli/dispatch.ts`:

Update the import (line 20) and add the agent import:

```ts
import { assertStdinIsTty, runRepoSearchCli } from './run-repo-search.js';
import { runRepoAgentCli } from './run-repo-agent.js';
```

Update the imports from `./args.js` (lines 3-9) to include `validateRepoAgentTokens`.

Replace the repo-search fast-fail block (lines 41-49) so both commands validate + fast-fail, and add the agent help pass-through:

```ts
    if (commandName === 'repo-search') {
      validateRepoSearchTokens(commandArgs);
      assertStdinIsTty(commandArgs.includes('--interactive'), options.stdin, '--interactive');
    }
    if (commandName === 'repo-agent') {
      validateRepoAgentTokens(commandArgs);
      // Approval is on unless --no-approval; a prompting run needs a TTY. Fail before the server preflight.
      assertStdinIsTty(!commandArgs.includes('--no-approval'), options.stdin, 'repo-agent approval mode');
    }
    if (commandName === 'repo-search' && commandHelpRequested) {
      return await runRepoSearchCli({ argv: options.argv, stdout, stderr, stdin: options.stdin });
    }
    if (commandName === 'repo-agent' && commandHelpRequested) {
      return await runRepoAgentCli({ argv: options.argv, stdout, stderr, stdin: options.stdin });
    }
```

Add the command case in the `switch` (after the `repo-search` case, line 99):

```ts
      case 'repo-agent':
        return await runRepoAgentCli({ argv: options.argv, stdout, stderr, stdin: options.stdin });
```

> Note: because both help pass-throughs fast-fail on TTY first, a non-TTY `repo-agent --help` would error before printing usage. To keep `--help` always usable, guard the agent TTY assertion with `!commandHelpRequested`:
>
> ```ts
>     if (commandName === 'repo-agent') {
>       validateRepoAgentTokens(commandArgs);
>       if (!commandHelpRequested) {
>         assertStdinIsTty(!commandArgs.includes('--no-approval'), options.stdin, 'repo-agent approval mode');
>       }
>     }
> ```
>
> Apply the same `!commandHelpRequested` guard to the existing repo-search assertion for consistency.

- [ ] **Step 6: Update help text**

In `src/cli/help.ts`:

```ts
import { REPO_SEARCH_SYNOPSIS, REPO_AGENT_SYNOPSIS } from './args.js';

export function showHelp(stdout: NodeJS.WritableStream): void {
  stdout.write([
    'SiftKit CLI',
    '',
    'Usage:',
    '  siftkit "question"',
    '  siftkit summary --question "..." [--text "..."] [--file path]',
    `  ${REPO_SEARCH_SYNOPSIS}`,
    `  ${REPO_AGENT_SYNOPSIS}`,
    '  siftkit -prompt "find x y z in this repo"',
    '  siftkit preset list',
    '  siftkit run --preset <id> ...',
    '  siftkit run --command <cmd> [--arg <a> ...] --question "..."',
    '  siftkit run --shell <auto|pwsh|powershell|bash|sh|cmd> --command "<script>" --question "..."',
    '',
    'Run `siftkit preset list` to read server-managed CLI presets.',
    '',
  ].join('\n'));
}
```

- [ ] **Step 7: Update the help test**

In `tests/cli-help.test.ts`, add an assertion that the help output includes `repo-agent` (match the existing assertion style in that file):

```ts
  assert.match(output, /siftkit repo-agent --prompt/u);
```

- [ ] **Step 8: Run to verify it passes**

Run: `node --test tests/repo-agent-cli.test.ts tests/cli-help.test.ts`
Expected: PASS.

- [ ] **Step 9: Regression — repo-search CLI unchanged**

Run: `node --test tests/repo-search-cli.test.ts tests/repo-search-cli-interactive.test.ts`
Expected: PASS. (These import `assertInteractiveStdinIsTty` — if so, update those imports to `assertStdinIsTty` with the `'--interactive'` context, or keep a re-export. Prefer updating the call sites; per project rules, no legacy shim.)

- [ ] **Step 10: Commit**

```bash
git add src/cli/run-repo-search.ts src/cli/run-repo-agent.ts src/cli/dispatch.ts src/cli/help.ts tests/repo-agent-cli.test.ts tests/cli-help.test.ts
git commit -m "feat(cli): add repo-agent command over shared runRepoTaskCli"
```

---

## Task 9: Full verification sweep

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the whole repo**

Run: `npm run typecheck`
Expected: PASS — no casts, no `any`, no `!`. The widened enums and new `taskKind` value flow through inference.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 3: Full test suite**

Run: `npm test`
Expected: PASS. Watch specifically for:
- Any remaining fixture asserting `DEFAULT_OPERATION_MODE_ALLOWED_TOOLS.full === []` or the builtin id list — fix inline.
- `resolvePresetAllowedTools` consumers / dashboard preset enumeration now seeing a non-empty `full` set.
- The summary `json_get` fixup path in `normalizeOperationModeAllowedTools` (unchanged, but re-confirm green).

- [ ] **Step 4: Manual smoke (optional, requires a running status server)**

```bash
siftkit repo-agent --prompt "print the repo name from package.json, do not edit" --no-approval --progress
```
Expected: runs autonomously, agent persona, returns a change summary.

- [ ] **Step 5: Commit any fixups**

```bash
git add -A
git commit -m "test: sweep fixtures for repo-agent full-mode defaults"
```

---

## Self-Review Notes (author checklist — already reconciled)

- **Spec §1 contracts** → Task 1. **§2 presets** → Task 2. **§3 agent prompt** → Task 3. **§4 execute** → Task 4. **§5 server** → Task 5. **§6 CLI** → Tasks 6–8. **§7 TTY/approval** → Tasks 5 (server gate) + 8 (CLI gate). **§8 tests** → each task is TDD; regression sweep in Task 9.
- **Open item (approval route):** resolved — shared `/repo-search/approval`, no new route (Tasks 5–6).
- **Deviation from spec, deliberate:** metrics `taskKind` for `repo-agent` maps to the `repo-search` bucket (no `TaskMetricKind`/dashboard churn), consistent with the shared `repo_search` lock + DB runKind in §5. `RepoSearchExecutionRequest.taskKind` still gains `'repo-agent'` as the behavioral discriminant (§4 satisfied).
- **Deviation from spec, deliberate:** agent prompt tool list is static (not sourced from `REPO_TOOL_REGISTRY`) to avoid an import cycle and dynamic coupling; content mirrors the registry descriptions.
- **Type consistency:** `assertStdinIsTty(required, stdin, context)` used identically in Task 5 (n/a — server) and Task 8 (CLI + dispatch). `runRepoTaskCli({ mode })` is the single runner; `runRepoSearchCli`/`runRepoAgentCli` are thin wrappers. `RepoTaskEndpoint.mode` is the single server discriminant; no functions passed dynamically.
