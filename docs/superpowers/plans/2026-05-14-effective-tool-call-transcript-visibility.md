# Effective Tool Call Transcript Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the model transcript replay runtime expansion/adjustment that changed the effective evidence window, while preserving the raw model request and routine normalization details in logs/artifacts.

**Architecture:** Repo-search already separates raw model output, parsed internal action, command normalization, execution, logging, and transcript replay. This change adds one explicit "effective transcript action" boundary so the model sees range/window expansions as if it requested them, including command-based line-read window adjustment and native `repo_read_file` unread-range expansion. Routine command normalization such as `rg --no-ignore`, ignore globs, type rewrites, and case flags remains hidden from model replay.

**Tech Stack:** TypeScript, Node test runner, existing SiftKit repo-search runtime, no new dependencies.

---

## File Structure

- Modify `src/repo-search/engine.ts`
  - Owns command normalization, native tool execution, command/result logging, and construction of `ToolBatchOutcome`.
  - Add a small helper for building model-visible effective actions from executed command/native execution metadata.
- Modify `tests/mock-repo-search-loop.test.ts`
  - Add regression tests for model transcript replay after command normalization and native `repo_read_file` expansion.
  - Existing line-read adjustment tests already cover command-based read-window replay; keep and extend them.
- Modify `tests/repo-search-loop.core.test.ts` only if a lower-level engine fixture already exposes the same transcript assertions more cleanly.
  - Do not duplicate the same assertion in both files unless one covers direct CLI and the other covers dashboard/status persistence.
- Do not modify `src/tool-call-messages.ts`.
  - It should keep serializing whatever action it is handed. The effective/raw decision belongs in repo-search engine code.
- Do not modify parser/schema/prompt code.
  - The direct JSON protocol already works. This plan changes replay visibility only.

## Invariants

- Raw model response remains logged as `turn_model_response.text`.
- Parsed raw model action remains logged as `turn_action_parsed.action`.
- `turn_command_result.requestedCommand` remains the raw/equivalent requested command.
- `turn_command_result.executedCommand` remains the effective command actually run.
- Model transcript assistant `tool_calls[].function.arguments` must use the effective action only when runtime expansion/adjustment changed the requested evidence window.
- Routine normalization flags and command cleanup must stay out of model-visible replay.
- Tool result content should not include noisy normalization notes unless the note is useful evidence. Keep rewrite notes in logs/artifacts, not model transcript.
- Rejections should replay the rejected effective command/action that triggered the rejection.

---

### Task 1: Add Failing Test for Native `repo_read_file` Expansion Replay

**Files:**
- Modify: `tests/mock-repo-search-loop.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test near the existing line-read overlap tests around `lineReadAdjusted`. The test should force a repeated direct `repo_read_file` request whose second requested range overlaps prior returned lines, then assert the next planner prompt replays the effective expanded range.

```ts
test('repo_read_file transcript replay uses effective unread range after native expansion', async () => {
  const inputText = Array.from({ length: 260 }, (_, index) => `line ${index + 1}`).join('\n');
  const mockResponses = [
    JSON.stringify({ action: 'repo_read_file', path: 'src/big-file.ts', startLine: 1, endLine: 80 }),
    JSON.stringify({ action: 'repo_read_file', path: 'src/big-file.ts', startLine: 40, endLine: 90 }),
    JSON.stringify({ action: 'finish', output: 'done', confidence: 0.9 }),
  ];
  const seenPrompts: string[] = [];

  const scorecard = await runMockRepoSearchLoop({
    files: {
      'src/big-file.ts': inputText,
    },
    mockResponses,
    onPlannerRequest: (request) => {
      seenPrompts.push(JSON.stringify(request.messages));
    },
  });

  assert.equal(scorecard.verdict, 'pass');
  const secondReplay = seenPrompts[2] || '';
  assert.match(secondReplay, /"name":"repo_read_file"/u);
  assert.match(secondReplay, /"path":"src\\/big-file\\.ts"/u);
  assert.doesNotMatch(secondReplay, /"startLine":40,"endLine":90/u);
  assert.match(secondReplay, /"startLine":81/u);
  assert.match(secondReplay, /"endLine":260/u);
});
```

If `runMockRepoSearchLoop` does not currently expose `files` or `onPlannerRequest`, use the local helper pattern already present in `tests/mock-repo-search-loop.test.ts` for temporary repo files and captured `turn_new_messages` logger events. The assertion must inspect the assistant replay message, not only `turn_command_result`.

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm test -- mock-repo-search-loop.test.ts
```

Expected before implementation:

```text
FAIL repo_read_file transcript replay uses effective unread range after native expansion
```

The failure should show the replayed assistant args still contain the original `startLine/endLine` from the model request.

---

### Task 2: Add Failing Test That Routine `repo_rg` Normalization Is Not Replayed

**Files:**
- Modify: `tests/mock-repo-search-loop.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test that emits a minimal direct `repo_rg` command. Assert audit fields keep raw vs executed, and the replayed assistant call keeps the raw requested command without `--no-ignore` or ignore globs.

```ts
test('repo_rg transcript replay hides routine normalization while audit keeps effective command', async () => {
  const mockResponses = [
    JSON.stringify({ action: 'repo_rg', command: 'rg -n "needle" src' }),
    JSON.stringify({ action: 'finish', output: 'done', confidence: 0.9 }),
  ];
  const events: Array<Record<string, unknown>> = [];

  const scorecard = await runMockRepoSearchLoop({
    files: {
      'src/index.ts': 'export const needle = true;\n',
    },
    mockResponses,
    onLogEvent: (event) => events.push(event),
  });

  assert.equal(scorecard.verdict, 'pass');

  const commandResult = events.find((event) => event.kind === 'turn_command_result' && event.turn === 1);
  assert.equal(String(commandResult?.requestedCommand), 'rg -n "needle" src');
  assert.match(String(commandResult?.executedCommand), /rg -n "needle" src --no-ignore/u);

  const turnTwo = events.find((event) => event.kind === 'turn_new_messages' && event.turn === 2);
  const messages = Array.isArray(turnTwo?.messages) ? turnTwo.messages : [];
  const assistant = messages.find((message) => Array.isArray(message?.tool_calls));
  const argsText = String(assistant?.tool_calls?.[0]?.function?.arguments || '');
  const args = JSON.parse(argsText) as { command?: string };

  assert.equal(String(args.command || ''), 'rg -n "needle" src');
  assert.doesNotMatch(String(args.command || ''), /--no-ignore|--glob/u);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm test -- mock-repo-search-loop.test.ts
```

Expected before implementation:

```text
FAIL repo_rg transcript replay hides routine normalization while audit keeps effective command
```

The expected failure before the final implementation is whichever side violates the rule: either audit loses the effective command, or assistant replay leaks routine normalization flags.

---

### Task 3: Implement Effective Transcript Action Builder

**Files:**
- Modify: `src/repo-search/engine.ts`

- [ ] **Step 1: Add local helper types/functions near existing native execution helpers**

Add these helpers near the existing repo-search tool execution helpers, before `runTaskLoop`.

```ts
type EffectiveTranscriptActionOptions = {
  toolName: string;
  rawArgs: Record<string, unknown>;
  isNativeTool: boolean;
  commandToRun: string;
  nativeExecution: NativeRepoToolExecution | null;
};

function parseEffectiveReadFileArgs(command: string, fallbackArgs: Record<string, unknown>): Record<string, unknown> {
  const match = /^repo_read_file path=("(?:(?:\\")|[^"])*"|\\S+) startLine=(\\d+)(?: endLine=(\\d+))?/u.exec(command.trim());
  if (!match) {
    return fallbackArgs;
  }
  let pathText = String(fallbackArgs.path || '');
  try {
    pathText = JSON.parse(match[1]) as string;
  } catch {
    pathText = String(fallbackArgs.path || '');
  }
  return {
    path: pathText,
    startLine: Number.parseInt(match[2], 10),
    ...(match[3] ? { endLine: Number.parseInt(match[3], 10) } : {}),
  };
}

function buildEffectiveTranscriptAction(options: EffectiveTranscriptActionOptions): ToolTranscriptAction {
  if (!options.isNativeTool) {
    return {
      tool_name: options.toolName,
      args: { command: options.commandToRun },
    };
  }

  if (options.toolName === 'repo_read_file') {
    return {
      tool_name: options.toolName,
      args: parseEffectiveReadFileArgs(options.commandToRun, options.rawArgs),
    };
  }

  return {
    tool_name: options.toolName,
    args: options.rawArgs,
  };
}
```

If `NativeRepoToolExecution` has a different local type name, use the existing type returned by the native execution function. Keep the helper explicit; do not pass callback functions.

- [ ] **Step 2: Replace `modelVisibleCommand` replay selection**

In `src/repo-search/engine.ts`, keep model-visible command selection expansion-aware:

```ts
const modelVisibleCommand = isNativeTool || lineReadAdjustment || !normalized.rewritten
  ? commandToRun
  : requestedCommand;
```

This makes true expansions visible (`lineReadAdjustment`, native `repo_read_file`) while keeping routine normalization hidden (`normalized.rewritten` without expansion).

- [ ] **Step 3: Replace batch outcome action construction for successful tools**

Replace:

```ts
action: {
  tool_name: normalizedToolName,
  args: isNativeTool ? toolAction.args : { command: modelVisibleCommand },
},
```

with:

```ts
action: buildEffectiveTranscriptAction({
  toolName: normalizedToolName,
  rawArgs: toolAction.args,
  isNativeTool,
  commandToRun,
  nativeExecution,
}),
```

- [ ] **Step 4: Replace rejection batch outcomes**

For native rejection and normalized rejection paths, use the same helper with the best effective command known at that point.

Native rejection:

```ts
action: buildEffectiveTranscriptAction({
  toolName: normalizedToolName,
  rawArgs: toolAction.args,
  isNativeTool,
  commandToRun: nativeExecution?.command || command,
  nativeExecution,
}),
```

Normalized rejection:

```ts
action: buildEffectiveTranscriptAction({
  toolName: normalizedToolName,
  rawArgs: toolAction.args,
  isNativeTool,
  commandToRun: command,
  nativeExecution: null,
}),
```

Safety rejection after `commandToRun` is known:

```ts
const rejectedModelVisibleCommand = isNativeTool || lineReadAdjustment || !normalized.rewritten
  ? commandToRun
  : requestedCommand;
action: buildEffectiveTranscriptAction({
  toolName: normalizedToolName,
  rawArgs: toolAction.args,
  isNativeTool,
  commandToRun: rejectedModelVisibleCommand,
  nativeExecution,
}),
```

- [ ] **Step 5: Run focused tests**

Run:

```powershell
npm test -- mock-repo-search-loop.test.ts
```

Expected:

```text
pass
```

---

### Task 4: Preserve Audit Log Semantics and Add Assertions

**Files:**
- Modify: `tests/mock-repo-search-loop.test.ts`
- Modify: `src/repo-search/engine.ts` only if assertions reveal drift

- [ ] **Step 1: Strengthen audit assertions**

In the new tests, assert all of these remain true:

```ts
assert.equal(String(commandResult?.requestedCommand), '<raw model command>');
assert.match(String(commandResult?.executedCommand), /<effective command evidence>/u);
assert.equal(String(commandResult?.insertedResultText || '').includes('note: added --no-ignore'), false);
assert.match(String(commandResult?.output || ''), /note: added --no-ignore/u);
```

For native `repo_read_file`, assert:

```ts
assert.match(String(commandResult?.requestedCommand || ''), /startLine=40 endLine=90/u);
assert.match(String(commandResult?.executedCommand || ''), /startLine=81 endLine=260/u);
assert.equal(commandResult?.lineReadAdjusted, false);
```

The native unread-range expansion is not the same as `lineReadAdjusted`; do not re-label it.

- [ ] **Step 2: Run targeted tests**

Run:

```powershell
npm test -- mock-repo-search-loop.test.ts
```

Expected:

```text
pass
```

---

### Task 5: Add Persisted Transcript Regression

**Files:**
- Modify: `tests/repo-search-status-server.test.ts` or `tests/dashboard-status-server.test.ts`

- [ ] **Step 1: Write persisted artifact assertion**

Pick the smaller existing status-server repo-search artifact test. Add a mock repo-search response sequence:

```ts
mockResponses: [
  '{"action":"repo_rg","command":"rg -n \\"needle\\" src"}',
  '{"action":"finish","output":"done","confidence":0.9}'
]
```

After the request completes, load the persisted transcript artifact and assert the assistant replay keeps routine normalization hidden:

```ts
const transcriptText = String(transcriptArtifact.content_text || '');
assert.match(transcriptText, /"name":"repo_rg"/u);
assert.match(transcriptText, /rg -n \\"needle\\" src/u);
assert.doesNotMatch(transcriptText, /rg -n \\"needle\\" src --no-ignore/u);
```

- [ ] **Step 2: Run targeted persisted test**

Run:

```powershell
npm test -- repo-search-status-server.test.ts
```

Expected:

```text
pass
```

If existing managed-llama lifecycle tests fail with `EPERM` or missing rejection, rerun only the specific persisted transcript test by test name if the runner supports it. Do not change managed-llama behavior in this plan.

---

### Task 6: Verify No Prompt Noise Regression

**Files:**
- Modify: `tests/tool-loop-governor.test.ts` only if existing expectations are incomplete.

- [ ] **Step 1: Confirm prompt result still strips normalization notes**

Existing tests cover `buildPromptToolResult` stripping repo-search rewrite notes. Add this explicit combined case if absent:

```ts
test('buildPromptToolResult strips command expansion notes but keeps real output', () => {
  const promptResult = buildPromptToolResult({
    toolName: 'repo_rg',
    command: 'rg -n "needle" src --no-ignore',
    exitCode: 0,
    rawOutput: [
      'note: added --no-ignore so rg searches gitignored paths',
      'src/index.ts:1:needle',
    ].join('\n'),
  });

  assert.doesNotMatch(promptResult, /note: added --no-ignore/u);
  assert.match(promptResult, /src\\/index\\.ts:1:needle/u);
});
```

- [ ] **Step 2: Run governor tests**

Run:

```powershell
npm test -- tool-loop-governor.test.ts
```

Expected:

```text
pass
```

---

### Task 7: Run Full Relevant Validation

**Files:**
- No code changes unless a test reveals a real regression.

- [ ] **Step 1: Run focused repo-search tests**

Run:

```powershell
npm test -- mock-repo-search-loop.test.ts repo-search-loop.core.test.ts repo-search-planner-protocol.test.ts model-json.test.ts
```

Expected:

```text
pass
```

- [ ] **Step 2: Run status/dashboard surfaces touched by persisted transcript behavior**

Run:

```powershell
npm test -- repo-search-status-server.test.ts dashboard-status-server.test.ts
```

Expected:

```text
pass
```

If `repo-search-status-server.test.ts` fails only in managed-llama lifecycle tests unrelated to transcript replay, capture the exact failures in the final report and keep this implementation scoped.

- [ ] **Step 3: Run build**

Run:

```powershell
npm run build
```

Expected:

```text
vite build completes and sync-dist-runtime.js completes
```

- [ ] **Step 4: Review diff with SiftKit**

Run:

```powershell
git diff -- src tests docs | siftkit summary --question "Summarize behavioral changes and risks for effective tool-call transcript visibility. Identify unrelated changes."
```

Expected:

```text
Summary says replay now exposes true runtime expansions, hides routine normalization flags, preserves raw requested vs executed audit fields, and has no unrelated changes.
```

---

## Self-Review

**Spec coverage:** The plan covers all requested visibility cases: routine command normalization hidden from model replay, command-based read-window adjustment visible, native `repo_read_file` unread-range expansion visible, rejection replay, audit preservation, and persisted transcripts.

**Placeholder scan:** No task says to add generic handling without exact code or assertions. Every behavior has a concrete test assertion and target file.

**Type consistency:** The plan uses existing `ToolTranscriptAction`, `ToolBatchOutcome`, `requestedCommand`, `executedCommand`, `lineReadAdjusted`, and `nativeExecution` concepts. The new helper returns the existing transcript action type and does not change public parser protocol.

## Execution Notes

- Keep model transcript coherent with effective expanded state.
- Keep logs/artifacts detailed enough to debug raw vs normalized behavior.
- Do not add legacy wrapper compatibility.
- Do not change model-facing prompt protocol.
- Do not put normalization notes into model-visible tool output unless a later test proves the model needs them.
