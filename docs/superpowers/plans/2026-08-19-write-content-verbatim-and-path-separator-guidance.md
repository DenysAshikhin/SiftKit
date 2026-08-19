# Verbatim `write` Content and Path-Separator Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the planner-action parser from trimming `write.content` (which silently destroys trailing newlines and defeats the CRLF preservation added in 8cd01825), and add model-facing path-separator guidance that prevents backslash-escape corruption without assuming every invoked executable accepts forward slashes.

**Architecture:** Two independent, small changes at the same seam — "model emits a JSON string, we mutate it before the tool runs." Task 1 splits the `requiredText` argument category in `src/lib/model-json.ts` into trimmed args (paths, patterns, commands, URLs) and a new verbatim category used only by `write.content`, so whitespace-significant payloads pass through untouched. Task 2 adds one guideline line to the repo-agent system prompt in `src/repo-search/prompts.ts`, because a `\n` swallowed from a Windows path inside a `run` command is provably indistinguishable from an intended statement separator and can only be prevented, never repaired. The current parser table is the implementation target; this plan does not revive the unimplemented runtime-profile schema migration.

**Tech Stack:** TypeScript (strict, ESM, `.js` import specifiers), `node:test` + `node:assert/strict`, custom test runner at `dist/test-runner/run-tests.js`, ESLint.

## Global Constraints

- Do not commit. Leave the reviewed changes in the working tree for the requester to inspect and commit separately.
- Preserve all pre-existing and unrelated changes.
- The instruction in `docs/superpowers/plans/2026-07-23-repo-agent-runtime-profile-refactor.md` to delete `REPO_TOOL_ARG_SPECS` is superseded for this change. That migration was not implemented; do not add its schemas or partially execute it here. A future complete runtime-profile refactor must carry the `write.content` verbatim invariant into its replacement schema.

---

## Background: why this is a bug

Read this before starting; it explains what "correct" means for both tasks.

`src/lib/model-json.ts:658-665` validates required string arguments for native repo tools:

```ts
for (const key of argSpec.requiredText) {
  const rawValue = rawArgs[key];
  const value = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!value) {
    return { ok: false, reason: `"${toolName}" requires "${key}" to be a non-empty string` };
  }
  args[key] = restoreToolArgumentSeparators(toolName, key, value);
}
```

Line 660 trims, and line 664 stores the **trimmed** value — so this is not merely an emptiness check, it mutates the argument. `write` declares `requiredText: ['path', 'content']` at `src/lib/model-json.ts:73`, so file bodies go through it.

Consequence: a model writing a file ending in `...last line\n` produces a file with no trailing newline on disk. This directly defeats commit 8cd01825, which made `executeWrite` (`src/repo-search/engine/repo-tools.ts:887-895`) re-apply a detected CRLF style when overwriting a uniformly-CRLF file — `applyEolStyle` can only convert newlines that still exist, and the final one was already stripped upstream. Second consequence: `if (!value)` rejects whitespace-only content, so a file whose entire body is `"\n"` cannot be written at all.

Two doc comments are made accurate only by this fix: `src/lib/model-json.ts:61-63` claims `requiredText` args "must arrive as non-empty strings or the call is rejected" without mentioning the mutation, and `:106` claims "file content are left verbatim" (true of separator repair only, false overall while the trim exists).

For Task 2: `COMMAND_PATH_CONTROL_ESCAPES` (`src/lib/model-json.ts:89`) deliberately excludes `\n` and only repairs control characters sitting between two non-space characters, because newlines in a shell command are legitimate statement separators. The comment at `:84-86` already states the residual gap: a `\n` swallowed from `\node_modules` is unrecoverable. **Do not change either regex** — the asymmetry is correct. Prevention via prompt guidance is the only remedy.

The earlier runtime-profile plan proposed replacing `REPO_TOOL_ARG_SPECS`, but the replacement schema and its structural test do not exist in the current source tree. This plan therefore treats the current parser table as authoritative and supersedes only that earlier deletion instruction. Do not mix the two changes: adding a partial schema migration here would create parallel validation paths and violate the complete-replacement rule.

---

## File Structure

- **Modify** `src/lib/model-json.ts` — add a `verbatimText` argument category; move `write.content` into it; correct two doc comments. No other file reads `REPO_TOOL_ARG_SPECS` (verified: only `src/lib/model-json.ts:65` declares it and `:653` reads it), so the change is local.
- **Modify** `tests/model-json.test.ts` — regression tests for whitespace-significant content and unchanged trimming elsewhere.
- **Modify** `tests/repo-search-agent-execute.test.ts` — integration regression proving a model-emitted write retains leading and trailing whitespace on disk.
- **Modify** `src/repo-search/prompts.ts` — one new line in the `buildAgentSystemPrompt` Guidelines list.
- **Modify** `tests/repo-search-prompts.test.ts` — assert the guidance is present.

---

## Task 1: Pass `write.content` through verbatim

**Files:**
- Modify: `src/lib/model-json.ts:60-78` (arg-spec type + `write` entry), `:106` (doc comment), `:657-672` (validation loops)
- Test: `tests/model-json.test.ts`
- Test: `tests/repo-search-agent-execute.test.ts`

There is already a test named `'ModelJson never rewrites write content or edit payloads'` at `tests/model-json.test.ts:663`. It passes today only because its fixture content (`'line1\n\tindented\nline3'`) has no leading or trailing whitespace. Leave that test alone and add new ones below it; its name is what this task makes true in general.

- [ ] **Step 1: Write the failing tests**

Add these three tests to `tests/model-json.test.ts`, immediately after the existing test that ends at line 680-ish (`'ModelJson never rewrites write content or edit payloads'`). They use the file's existing `parseRepoSearchPlannerAction` helper (defined at `tests/model-json.test.ts:19-26`).

```ts
// Trailing newlines are the payload for file writes: trimming them here silently defeats the
// CRLF re-application in executeWrite, which can only convert newlines that still exist.
test('ModelJson preserves leading and trailing whitespace in write content', () => {
  const content = '\n  leading blank line kept\nlast line\n';
  const action = parseRepoSearchPlannerAction(JSON.stringify({ action: 'write', path: 'a.ts', content }), [
    'write',
  ]);

  assert.deepEqual(action, {
    action: 'tool',
    tool_name: 'write',
    args: { path: 'a.ts', content },
  });
});

test('ModelJson accepts whitespace-only write content but still rejects an empty string', () => {
  const action = parseRepoSearchPlannerAction(JSON.stringify({ action: 'write', path: 'a.ts', content: '\n' }), [
    'write',
  ]);

  assert.deepEqual(action, {
    action: 'tool',
    tool_name: 'write',
    args: { path: 'a.ts', content: '\n' },
  });

  assert.throws(
    () => parseRepoSearchPlannerAction(JSON.stringify({ action: 'write', path: 'a.ts', content: '' }), ['write']),
    /"write" requires "content" to be a non-empty string/u,
  );
  assert.throws(
    () => parseRepoSearchPlannerAction(JSON.stringify({ action: 'write', path: 'a.ts' }), ['write']),
    /"write" requires "content" to be a non-empty string/u,
  );
});

test('ModelJson still trims surrounding whitespace from path and command arguments', () => {
  const writeAction = parseRepoSearchPlannerAction(
    JSON.stringify({ action: 'write', path: '  a.ts  ', content: 'body' }),
    ['write'],
  );
  assert.deepEqual(writeAction, {
    action: 'tool',
    tool_name: 'write',
    args: { path: 'a.ts', content: 'body' },
  });

  const runAction = parseRepoSearchPlannerAction(
    JSON.stringify({ action: 'run', command: '  npm run lint  ' }),
    ['run'],
  );
  assert.deepEqual(runAction, {
    action: 'tool',
    tool_name: 'run',
    args: { command: 'npm run lint' },
  });
});
```

- [ ] **Step 2: Strengthen the existing repo-agent write integration test**

In `tests/repo-search-agent-execute.test.ts`, replace the existing test named `'repo-agent taskKind runs the agent prompt and applies a write without approval gate'` with this version. `JSON.stringify` is deliberate: it produces the same JSON text a model response supplies while keeping the expected payload readable in the test.

```ts
test('repo-agent applies write content verbatim without an approval gate', async () => {
  const dir = createManagedTempDir('siftkit-agent-exec-');
  const content = '\n  agent wrote this\n';
  try {
    const result = await executeRepoSearchRequest({
      presetId: 'repo-search',
      taskKind: 'repo-agent',
      prompt: 'create out.txt',
      repoRoot: dir,
      config: MOCK_CONFIG,
      model: 'mock',
      maxTurns: 4,
      allowedTools: [...INTERACTIVE_REPO_TOOL_NAMES],
      availableModels: ['mock'],
      mockResponses: [
        JSON.stringify({ action: 'write', path: 'out.txt', content }),
        '{"action":"finish","output":"created out.txt"}',
      ],
      mockCommandResults: {},
    });
    assert.equal(result.scorecard.verdict === 'fail', false);
    assert.equal(fs.readFileSync(path.join(dir, 'out.txt'), 'utf8'), content);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```powershell
npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js model-json repo-search-agent-execute }
```

Expected: FAIL. The first unit test fails on a `deepEqual` mismatch — actual `content` is `'leading blank line kept\nlast line'` (both the leading `\n  ` and the trailing `\n` stripped). The second unit test fails because `content: '\n'` throws `"write" requires "content" to be a non-empty string`. The third unit test passes already (it pins behavior that must not regress). The integration test fails because `out.txt` contains `'agent wrote this'` instead of `content`.

- [ ] **Step 4: Add the `verbatimText` category to the argument specs**

In `src/lib/model-json.ts`, replace the doc comment and spec table at lines 60-78 with:

```ts
/**
 * Per-tool argument shape for the native (non-`git`) repo tools. `requiredText` args are trimmed and
 * must be non-empty or the call is rejected; `verbatimText` args must be non-empty but are stored
 * exactly as the model wrote them, because surrounding whitespace is part of the payload;
 * `optional` args are passed through untouched and value-validated by engine/repo-tools.ts.
 */
const REPO_TOOL_ARG_SPECS: Record<
  string,
  {
    requiredText: readonly string[];
    verbatimText?: readonly string[];
    requiredArray?: readonly string[];
    optional: readonly string[];
  }
> = {
  read: { requiredText: ['path'], optional: ['offset', 'limit'] },
  grep: {
    requiredText: ['pattern'],
    optional: ['path', 'glob', 'ignoreCase', 'literal', 'context', 'limit'],
  },
  find: { requiredText: ['pattern'], optional: ['path', 'limit'] },
  ls: { requiredText: [], optional: ['path', 'limit'] },
  write: { requiredText: ['path'], verbatimText: ['content'], optional: [] },
  edit: { requiredText: ['path'], requiredArray: ['edits'], optional: [] },
  run: { requiredText: ['command'], optional: ['timeout', 'timeoutMs'] },
  web_search: { requiredText: ['query'], optional: ['timeFilter'] },
  web_fetch: { requiredText: ['url'], optional: [] },
};
```

- [ ] **Step 5: Add the verbatim validation loop**

In `src/lib/model-json.ts`, insert this loop directly after the `requiredText` loop (which ends at line 665, before the `requiredArray` loop at line 666):

```ts
    for (const key of argSpec.verbatimText ?? []) {
      const rawValue = rawArgs[key];
      if (typeof rawValue !== 'string' || rawValue.length === 0) {
        return { ok: false, reason: `"${toolName}" requires "${key}" to be a non-empty string` };
      }
      args[key] = rawValue;
    }
```

Two deliberate differences from the `requiredText` loop, both required by the tests in Step 1:

1. The emptiness gate is `rawValue.length === 0`, not `.trim()`, so a body of `"\n"` is legal while a missing or empty argument still fails loudly with the same message shape used everywhere else.
2. No `restoreToolArgumentSeparators` call. Content is already exempt from separator repair (`src/lib/model-json.ts:114` returns non-path, non-`run.command` keys unchanged), and running path repair over a file body would corrupt every literal tab in it.

- [ ] **Step 6: Correct the separator-repair doc comment**

In `src/lib/model-json.ts`, replace the single-line comment at line 106:

```ts
/** Only path and command arguments are repaired; patterns, globs and file content are left verbatim. */
```

with:

```ts
/** Only path and command arguments are repaired; patterns and globs are left verbatim. File content
 * never reaches this function — it is stored exactly as written by the verbatimText loop. */
```

- [ ] **Step 7: Run the tests to verify they pass**

```powershell
npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js model-json repo-search-agent-execute }
```

Expected: PASS, including the on-disk integration regression and the pre-existing `'ModelJson never rewrites write content or edit payloads'` and `'ModelJson reports a distinct reason for each tool-argument rejection path'` tests, which must be unaffected.

- [ ] **Step 8: Run the write/CRLF tests that this change unblocks**

```powershell
node .\dist\test-runner\run-tests.js repo-tools
```

Expected: PASS. `executeWrite` is not modified by this task; this run confirms the CRLF behavior from 8cd01825 (`tests/repo-tools.test.ts:676-686`) still holds.

---

## Task 2: Give the agent safe path-separator guidance

**Files:**
- Modify: `src/repo-search/prompts.ts:302-313` (the `buildAgentSystemPrompt` Guidelines list)
- Test: `tests/repo-search-prompts.test.ts`

This guidance belongs in `buildAgentSystemPrompt` (`src/repo-search/prompts.ts:279-316`), not `buildTaskSystemPrompt`: `run` is agent-only (`src/repo-search/planner-protocol.ts:281`). Phrase it as general path guidance rather than run-specific, because `path` arguments suffer the same JSON-escape corruption in every mode — the difference is that `path` corruption is repairable (`PATH_CONTROL_ESCAPES`, `src/lib/model-json.ts:88`) and command corruption from `\n` is not. Prefer forward slashes, but do not claim universal compatibility: PowerShell accepts them for its filesystem paths, while a native executable may require backslashes in its own arguments. In that case the model must JSON-escape each backslash.

- [ ] **Step 1: Write the failing test**

Add this test to `tests/repo-search-prompts.test.ts`, after the test ending at line 240 (`'buildAgentSystemPrompt tells the run tool it is PowerShell on Windows with tail-truncated output'`). It uses the file's existing `buildTestContext` helper (`tests/repo-search-prompts.test.ts:25-35`).

```ts
// A backslash inside a JSON string is an escape, so `dashboard\node_modules` arrives as a real
// newline plus `ode_modules`. Inside a run command that is indistinguishable from an intended
// statement separator and cannot be repaired, so the prompt has to prevent it. Native executables
// may still require backslashes, which must be escaped in the JSON string rather than forbidden.
test('buildAgentSystemPrompt gives safe forward-slash and escaped-backslash path guidance', () => {
  const prompt = buildAgentSystemPrompt(buildTestContext(process.cwd(), false, true));
  const guidance =
    '- Prefer forward slashes for paths (`dashboard/node_modules`, `src/lib/foo.ts`), including inside `run` commands. If a native executable requires backslashes, JSON-escape each one as `\\\\`; an unescaped backslash in JSON can silently corrupt the argument.';

  assert.equal(prompt.includes(guidance), true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```powershell
npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js repo-search-prompts }
```

Expected: FAIL because `prompt.includes(guidance)` is `false`.

- [ ] **Step 3: Add the guideline line**

In `src/repo-search/prompts.ts`, insert this entry into the `buildAgentSystemPrompt` Guidelines array immediately after the PowerShell-syntax line at `:304` and before the tail-truncation line at `:305`:

```ts
    '- Prefer forward slashes for paths (`dashboard/node_modules`, `src/lib/foo.ts`), including inside `run` commands. If a native executable requires backslashes, JSON-escape each one as `\\\\`; an unescaped backslash in JSON can silently corrupt the argument.',
```

- [ ] **Step 4: Run the test to verify it passes**

```powershell
npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js repo-search-prompts }
```

Expected: PASS, including the pre-existing `'buildAgentSystemPrompt has persona, full tool list, edit-first guideline, and no search-discipline lines'` test at `tests/repo-search-prompts.test.ts:204`, which asserts on tool names and must be unaffected.

---

## Task 3: Full validation sweep

**Files:** none modified unless a failure is found.

- [ ] **Step 1: Confirm no other consumer depends on the old argument-spec shape**

```powershell
node .\dist\test-runner\run-tests.js model-json repo-tools repo-search-prompts repo-search-agent-execute
```

Expected: PASS. (`REPO_TOOL_ARG_SPECS` is declared at `src/lib/model-json.ts:65` and read only at `:653`, so no cross-module migration is outstanding. If a `verbatimText` reference appears anywhere else, that is a missed migration and must fail loudly rather than be shimmed.)

- [ ] **Step 2: Typecheck and lint**

```powershell
npm run typecheck 2>&1 | siftkit summary --question "Return pass/fail, every tsc or eslint error with its file:line anchor, and nothing else."
```

Expected: pass, zero errors. (`npm run typecheck` already chains `npm run lint` per `package.json:17`.)

- [ ] **Step 3: Run the full suite**

```powershell
npm run build:test; if ($?) { npm test 2>&1 | siftkit summary --question "Return pass/fail, total/passed/failed counts, the name of every failing test, and its root error with file:line anchors." }
```

Expected: pass, no failures. Any failure mentioning `write`, `content`, `trim`, or a prompt assertion is caused by this plan and must be fixed here, not deferred.

- [ ] **Step 4: Confirm the working tree contains only the intended changes**

```powershell
git status --short
```

Expected: clean, or only files listed in the File Structure section. Delete any scratch or temporary artifacts before finishing.

---

## Out of scope

Do not change `PATH_CONTROL_ESCAPES` or `COMMAND_PATH_CONTROL_ESCAPES` (`src/lib/model-json.ts:88-89`). Their asymmetry — paths repair every control character, commands repair everything except `\n` and only between non-space characters — is deliberate and documented at `:80-86`. Widening the command regex to cover `\n` would corrupt legitimate multi-line commands, which is a worse failure than the one it fixes.

Do not modify `executeWrite` (`src/repo-search/engine/repo-tools.ts:873-901`). Its CRLF handling is correct; it was only ever fed damaged input.
