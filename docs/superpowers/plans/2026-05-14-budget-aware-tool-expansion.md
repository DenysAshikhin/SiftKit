# Budget-Aware Tool Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every runtime-expanded tool call return the largest useful non-overlapping output that fits the tool context budget, and make transcript/log state match what actually returned.

**Architecture:** Treat expansion as a planned read window, not a side effect of execution. Expansion-aware tools compute requested range, unread/effective range, budget-fitted returned range, and transcript-visible action in one typed path. Routine normalization stays hidden; true runtime expansion remains visible. Shell/non-read tools keep existing output fitting and prompt-time hard rejection.

**Tech Stack:** TypeScript, Node test runner, existing `ToolOutputFitter`, repo-search native tools, summary planner tools, no new dependencies.

---

## Relevant Tool Surfaces

- Repo-search native `repo_read_file`
  - Current expansion: `src/repo-search/engine.ts:371-452`
  - Current dispatch before budget gates: `src/repo-search/engine.ts:1188-1189`
  - Current returned-range update: `src/repo-search/engine.ts:1698-1709`
- Repo-search command-based line reads through `Get-Content ... | Select-Object`
  - Current parse/adjust: `src/repo-search/engine/read-overlap.ts:195-224`, `src/repo-search/engine/read-overlap.ts:295-369`
  - Current engine adjustment: `src/repo-search/engine.ts:1418-1461`
  - Current returned-range update: `src/repo-search/engine.ts:1711-1723`
- Repo-search high-volume output tools with no expansion
  - `repo_rg`, `repo_list_files`, `repo_git`, etc. already flow through `ToolOutputFitter` at `src/repo-search/engine.ts:1648-1696`.
  - Keep them fitted when accepted; do not execute them after prompt-time budget expiry.
- Summary planner `read_lines`
  - Current expansion: `src/summary/planner/mode.ts:556-575`
  - Current execution: `src/summary/planner/tools.ts:371-385`, `src/summary/planner/mode.ts:592`
  - Current returned-range update: `src/summary/planner/mode.ts:730-738`
- Summary planner high-volume output tools with no range expansion
  - `find_text`, `json_filter`, `json_get` already flow through formatter/fitter at `src/summary/planner/mode.ts:667-705`.
  - Keep them fitted when accepted; do not add range semantics.

## Behavioral Rules

1. Forced-finish mode rejects all further tools before any expansion.
2. Prompt wall-clock budget expiry rejects shell/non-read tools before execution.
3. Prompt wall-clock budget expiry may allow one deterministic local bounded read if it can return immediately:
   - repo-search `repo_read_file`
   - summary planner `read_lines`
4. Allowed final bounded reads must:
   - avoid overlap with returned ranges
   - fit per-tool token cap and remaining prompt allowance
   - return a truncation/expansion note in the tool result
   - update read-state only for the lines actually returned
   - immediately enter forced-finish mode after appending the result
5. Native expansion must not be logged as executed unless output was actually returned.
6. Model replay must show the actual returned effective range, not the original request and not an unreturned expanded range.
7. Existing routine command normalization remains hidden from model replay.

---

### Task 1: Add Repo-Search Regression for Prompt-Budget Final `repo_read_file`

**Files:**
- Modify: `tests/repo-search.test.ts`
- Modify: `tests/mock-repo-search-loop.test.ts`

- [ ] **Step 1: Add endpoint-level failing test**

Add this test near `executeRepoSearchRequest blocks later tools and forces an answer when prompt budget expires` in `tests/repo-search.test.ts`.

```ts
test('executeRepoSearchRequest returns one fitted native read when prompt budget expires', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    const sourcePath = path.join(tempRoot, 'src');
    fs.mkdirSync(sourcePath, { recursive: true });
    fs.writeFileSync(
      path.join(sourcePath, 'big.ts'),
      Array.from({ length: 900 }, (_, index) => `export const line${index + 1} = ${index + 1};`).join('\n'),
      'utf8',
    );

    const result = await executeRepoSearchRequest({
      prompt: 'read enough evidence',
      repoRoot: tempRoot,
      maxTurns: 4,
      promptTimeoutMs: 20,
      mockResponses: [
        '{"action":"repo_git","command":"git status --short"}',
        '{"action":"repo_read_file","path":"src/big.ts","startLine":300,"endLine":900}',
        '{"action":"finish","output":"budget answer","confidence":0.8}',
      ],
      mockCommandResults: {
        'git status --short': { exitCode: 0, stdout: 'slow evidence', stderr: '', delayMs: 40 },
      },
    });

    const task = (result.scorecard.tasks as Array<{
      finalOutput: string;
      commands: Array<{ command: string; safe: boolean; output: string; reason: string | null }>;
    }>)[0];

    assert.equal(task.finalOutput, 'budget answer');
    assert.equal(task.commands.length, 2);
    assert.equal(task.commands[1].safe, true);
    assert.match(task.commands[1].command, /^repo_read_file path="src\/big\.ts" startLine=300 endLine=\d+$/u);
    assert.doesNotMatch(task.commands[1].reason || '', /prompt budget expired/u);
    assert.match(task.commands[1].output, /^note: prompt budget expired; returned bounded repo_read_file output/mu);
    assert.match(task.commands[1].output, /\d+ lines truncated due to per-tool context limit\./u);
    assert.match(task.commands[1].output, /^300: /mu);
  });
});
```

- [ ] **Step 2: Add loop-level transcript assertion**

Add this test near existing `repo_read_file` expansion tests in `tests/mock-repo-search-loop.test.ts`.

```ts
test('runTaskLoop replays only returned repo_read_file range after prompt-budget bounded read', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const result = await runTaskLoop(
    { id: 'task-budget-bounded-read', question: 'read file', signals: ['done'] },
    {
      maxTurns: 4,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      promptTimeoutMs: 1,
      mockResponses: [
        '{"action":"repo_rg","command":"rg -n \\"needle\\" src"}',
        '{"action":"repo_read_file","path":"src/big.ts","startLine":300,"endLine":900}',
        '{"action":"finish","output":"done","confidence":0.8}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'rg -n "needle" src': { exitCode: 0, stdout: 'src/big.ts:300:needle', stderr: '', delayMs: 5 },
      },
      files: {
        'src/big.ts': Array.from({ length: 900 }, (_, index) => `line ${index + 1}`).join('\n'),
      },
      logger: {
        write(event: Record<string, unknown> & { kind: string }) {
          events.push(event);
        },
      },
    }
  );

  assert.equal(result.reason, 'finish');
  const commandEvents = events.filter((event) => event.kind === 'turn_command_result');
  assert.equal(commandEvents.length, 2);
  assert.equal(commandEvents[1]?.safe, true);
  assert.match(String(commandEvents[1]?.requestedCommand || ''), /startLine=300 endLine=900/u);
  assert.match(String(commandEvents[1]?.executedCommand || ''), /startLine=300 endLine=\d+/u);
  assert.doesNotMatch(String(commandEvents[1]?.reason || ''), /prompt budget expired/u);
  assert.match(String(commandEvents[1]?.insertedResultText || ''), /^note: prompt budget expired; returned bounded repo_read_file output/mu);

  const turn3 = events.find((event) => event.kind === 'turn_new_messages' && event.turn === 3);
  const messages = Array.isArray(turn3?.messages) ? turn3.messages as Array<Record<string, unknown>> : [];
  const assistant = messages.find((message) => Array.isArray(message.tool_calls));
  const toolCalls = Array.isArray(assistant?.tool_calls) ? assistant.tool_calls as Array<Record<string, unknown>> : [];
  const fn = (toolCalls[0]?.function || {}) as Record<string, unknown>;
  const args = JSON.parse(String(fn.arguments || '{}')) as { startLine?: number; endLine?: number };
  assert.equal(String(fn.name || ''), 'repo_read_file');
  assert.equal(args.startLine, 300);
  assert.equal(Number(args.endLine) < 900, true);
});
```

- [ ] **Step 3: Run failing tests**

Run:

```powershell
npm test -- repo-search.test.ts mock-repo-search-loop.test.ts --test-name-pattern "prompt budget|bounded read"
```

Expected before implementation:

```text
FAIL executeRepoSearchRequest returns one fitted native read when prompt budget expires
FAIL runTaskLoop replays only returned repo_read_file range after prompt-budget bounded read
```

---

### Task 2: Split Native `repo_read_file` Planning From Execution

**Files:**
- Modify: `src/repo-search/engine.ts`
- Test: `tests/mock-repo-search-loop.test.ts`

- [ ] **Step 1: Add typed native read plan**

Add these types near `NativeRepoToolExecution`.

```ts
type RepoReadFilePlan = {
  requestedCommand: string;
  requestedStartLine: number;
  requestedEndLine: number;
  effectiveStartLine: number;
  effectiveEndLine: number;
  totalEndLineExclusive: number;
  pathKey: string;
  displayPath: string;
  absolutePath: string;
  lines: string[];
  hasUnread: boolean;
  noUnreadOutput: string | null;
};

type RepoReadFileFit = {
  executedCommand: string;
  output: string;
  returnedLineCount: number;
  truncatedLineCount: number;
  startLine: number;
  endLineExclusive: number;
  noteText: string | null;
};
```

- [ ] **Step 2: Extract planning function**

Move the path validation and unread-range calculation out of `executeNativeRepoTool()` into:

```ts
function planRepoReadFile(
  args: Record<string, unknown>,
  repoRoot: string,
  ignorePolicy: IgnorePolicy,
  fileReadStateByPath?: Map<string, FileReadState>,
): RepoReadFilePlan | { ok: false; command: string; reason: string } {
  const resolvedPath = resolveRepoScopedPath(repoRoot, args.path);
  const startLine = Math.max(1, Math.trunc(Number(args.startLine) || 1));
  const endLineCandidate = Math.trunc(Number(args.endLine) || 0);
  const requestedCommand = `repo_read_file path=${JSON.stringify(String(args.path || ''))} startLine=${startLine}${endLineCandidate > 0 ? ` endLine=${endLineCandidate}` : ''}`;
  if (!resolvedPath) {
    return { ok: false, command: requestedCommand, reason: 'path must stay within the repository root' };
  }
  if (isRepoRelativePathIgnored(resolvedPath.relativePath, ignorePolicy)) {
    return { ok: false, command: requestedCommand, reason: 'path is ignored by runtime policy' };
  }
  if (!fs.existsSync(resolvedPath.absolutePath) || !fs.statSync(resolvedPath.absolutePath).isFile()) {
    return { ok: false, command: requestedCommand, reason: 'path is not a readable file' };
  }

  const lines = fs.readFileSync(resolvedPath.absolutePath, 'utf8').replace(/\r\n/gu, '\n').split('\n');
  const pathKey = normalizeRepoRelativePathForDisplay(resolvedPath.relativePath).toLowerCase();
  const displayPath = normalizeRepoRelativePathForDisplay(resolvedPath.relativePath);
  const totalEndLineExclusive = (lines.length || 0) + 1;
  const clampedStart = Math.min(startLine, lines.length || 1);
  const requestedEnd = endLineCandidate > 0 ? endLineCandidate : lines.length;
  const requestedEndExclusive = Math.max(clampedStart + 1, Math.min(requestedEnd + 1, totalEndLineExclusive));
  const state = fileReadStateByPath ? getOrCreateFileReadState(fileReadStateByPath, pathKey) : null;
  const hasReturnedRanges = Boolean(state && state.mergedReturnedRanges.length > 0);
  const unreadRange = findContiguousUnreadRange({
    requestedStart: clampedStart,
    totalEnd: hasReturnedRanges ? totalEndLineExclusive : requestedEndExclusive,
    returnedRanges: state?.mergedReturnedRanges || [],
  });

  return {
    requestedCommand,
    requestedStartLine: clampedStart,
    requestedEndLine: requestedEndExclusive - 1,
    effectiveStartLine: unreadRange.start,
    effectiveEndLine: unreadRange.end - 1,
    totalEndLineExclusive,
    pathKey,
    displayPath,
    absolutePath: resolvedPath.absolutePath,
    lines,
    hasUnread: unreadRange.hasUnread,
    noUnreadOutput: unreadRange.hasUnread ? null : `No unread lines remain for ${displayPath}.`,
  };
}
```

- [ ] **Step 3: Add fitted execution function**

Add:

```ts
async function fitRepoReadFilePlan(options: {
  plan: RepoReadFilePlan;
  commandTokenBudget: number;
  countToolOutputTokens(text: string): Promise<number>;
  noteText: string | null;
}): Promise<RepoReadFileFit> {
  if (!options.plan.hasUnread) {
    return {
      executedCommand: options.plan.requestedCommand,
      output: options.plan.noUnreadOutput || '',
      returnedLineCount: 0,
      truncatedLineCount: 0,
      startLine: options.plan.effectiveStartLine,
      endLineExclusive: options.plan.effectiveStartLine,
      noteText: options.noteText,
    };
  }

  const selectedLines = options.plan.lines
    .slice(options.plan.effectiveStartLine - 1, options.plan.effectiveEndLine)
    .map((line, index) => `${options.plan.effectiveStartLine + index}: ${line}`);
  const fitter = new ToolOutputFitter({
    async countToolOutputTokens(text: string): Promise<number> {
      return await options.countToolOutputTokens(text);
    },
  });
  const fit = await fitter.fitSegments({
    headerText: options.noteText || undefined,
    segments: selectedLines,
    separator: '\n',
    maxTokens: options.commandTokenBudget,
    unit: 'lines',
  });
  const returnedLineCount = Math.max(0, fit.returnedLineCount);
  const endLineExclusive = options.plan.effectiveStartLine + returnedLineCount;
  return {
    executedCommand: `repo_read_file path=${JSON.stringify(options.plan.displayPath)} startLine=${options.plan.effectiveStartLine} endLine=${Math.max(options.plan.effectiveStartLine, endLineExclusive - 1)}`,
    output: fit.visibleText,
    returnedLineCount,
    truncatedLineCount: fit.truncatedLineCount,
    startLine: options.plan.effectiveStartLine,
    endLineExclusive,
    noteText: options.noteText,
  };
}
```

- [ ] **Step 4: Keep `executeNativeRepoTool()` as a compatibility shell**

Change `executeNativeRepoTool()` to call `planRepoReadFile()` and `fitRepoReadFilePlan()` for normal execution. This keeps current call sites simple while allowing the main loop to plan before prompt-budget salvage.

- [ ] **Step 5: Run native read tests**

Run:

```powershell
npm test -- mock-repo-search-loop.test.ts repo-search-loop.core.test.ts --test-name-pattern "repo_read_file|native"
```

Expected:

```text
existing native read tests pass except prompt-budget bounded-read tests still fail until Task 3
```

---

### Task 3: Move Native Expansion After Forced-Finish Gate and Add Prompt-Budget Salvage

**Files:**
- Modify: `src/repo-search/engine.ts`
- Test: `tests/repo-search.test.ts`
- Test: `tests/mock-repo-search-loop.test.ts`

- [ ] **Step 1: Stop executing native tools before rejection gates**

Replace the early native execution block:

```ts
const nativeExecution = isNativeTool
  ? executeNativeRepoTool(normalizedToolName, toolAction.args, options.repoRoot, ignorePolicy, fileReadStateByPath)
  : null;
const command = isCommandTool
  ? (typeof toolAction.args.command === 'string' ? toolAction.args.command : '')
  : nativeExecution?.command || '';
```

with:

```ts
const nativeReadPlan = isNativeTool && normalizedToolName === 'repo_read_file'
  ? planRepoReadFile(toolAction.args, options.repoRoot, ignorePolicy, fileReadStateByPath)
  : null;
const nativeExecution = null;
const command = isCommandTool
  ? (typeof toolAction.args.command === 'string' ? toolAction.args.command : '')
  : nativeReadPlan && 'requestedCommand' in nativeReadPlan
    ? nativeReadPlan.requestedCommand
    : nativeReadPlan?.command || '';
```

Do not format output or calculate an expanded executed command here.

- [ ] **Step 2: Keep forced-finish hard rejection first**

Leave `if (inForcedFinishMode)` before prompt-budget salvage. It must reject without expansion or file read.

- [ ] **Step 3: Add bounded final-read policy for prompt budget expiry**

Replace the prompt-budget expiry branch with logic that allows `repo_read_file` once:

```ts
const promptBudgetExpired = promptBudgetMs > 0
  && firstToolCallStartedAtMs !== null
  && Date.now() - firstToolCallStartedAtMs >= promptBudgetMs;
const canReturnBudgetedNativeRead = promptBudgetExpired
  && isNativeTool
  && normalizedToolName === 'repo_read_file'
  && nativeReadPlan !== null
  && 'requestedCommand' in nativeReadPlan;

if (promptBudgetExpired && !canReturnBudgetedNativeRead) {
  // existing rejection path
}
```

When `canReturnBudgetedNativeRead` is true, continue into execution but set:

```ts
const promptBudgetBoundedReadNote = 'note: prompt budget expired; returned bounded repo_read_file output. Return a finish action next.';
const forceFinishAfterAcceptedTool = true;
```

- [ ] **Step 4: Execute native read with the actual remaining output budget**

Before fitting, compute:

```ts
const promptTokenCount = preflight.promptTokenCount;
const dynamicPerToolRatio = Math.max(PER_TOOL_RESULT_RATIO, Number(commands.length) / Number(maxTurns));
const perToolCapTokens = Math.max(1, Math.floor(usablePromptTokens * dynamicPerToolRatio));
const remainingTokenAllowance = Math.max(
  usablePromptTokens - promptTokenCount - acceptedToolPromptTokensThisTurn,
  0,
);
const nativeReadTokenBudget = Math.max(1, Math.min(perToolCapTokens, remainingTokenAllowance));
```

Then call `fitRepoReadFilePlan()` with the note.

- [ ] **Step 5: Update state only for returned lines**

Use `fit.returnedLineCount`, not requested/effective range size:

```ts
if (fit.returnedLineCount > 0) {
  fileReadState.mergedReturnedRanges = mergeRange(fileReadState.mergedReturnedRanges, {
    start: fit.startLine,
    end: fit.endLineExclusive,
  });
}
```

- [ ] **Step 6: Force finish after accepted bounded read**

After appending batch outcomes, if `forceFinishAfterAcceptedTool` is true:

```ts
forcedFinishAttemptsRemaining = FORCED_FINISH_MAX_ATTEMPTS;
pendingModeChangeUserMessages.push('Prompt budget expired after a bounded read. Return {"action":"finish",...} now. Tool calls are blocked.');
```

- [ ] **Step 7: Run tests**

Run:

```powershell
npm test -- repo-search.test.ts mock-repo-search-loop.test.ts --test-name-pattern "prompt budget|bounded read|repo_read_file"
```

Expected:

```text
all selected tests pass
```

---

### Task 4: Make Command-Based `Get-Content` Expansion Budget-Aware

**Files:**
- Modify: `src/repo-search/engine.ts`
- Modify: `src/repo-search/engine/read-overlap.ts` only if a helper needs to move
- Test: `tests/mock-repo-search-loop.test.ts`

- [ ] **Step 1: Add failing test for adjusted `Get-Content` fitting**

Add near `runTaskLoop widens repeated Get-Content reads...`:

```ts
test('runTaskLoop fits adjusted Get-Content read window and records only returned lines', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const result = await runTaskLoop(
    { id: 'task-fit-adjusted-get-content', question: 'read adjusted file', signals: ['done'] },
    {
      maxTurns: 4,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        '{"action":"repo_get_content","command":"Get-Content src\\\\big.ts | Select-Object -First 10"}',
        '{"action":"repo_get_content","command":"Get-Content src\\\\big.ts | Select-Object -Skip 0 -First 900"}',
        '{"action":"finish","output":"done","confidence":0.8}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'Get-Content src\\big.ts | Select-Object -First 10': { exitCode: 0, stdout: 'a\n'.repeat(10), stderr: '' },
        'Get-Content src\\big.ts | Select-Object -Skip ': { exitCode: 0, stdout: 'b\n'.repeat(900), stderr: '' },
      },
      logger: { write(event) { events.push(event); } },
    }
  );

  assert.equal(result.reason, 'finish');
  const commandEvents = events.filter((event) => event.kind === 'turn_command_result');
  assert.equal(commandEvents[1]?.lineReadAdjusted, true);
  assert.match(String(commandEvents[1]?.insertedResultText || ''), /\d+ lines truncated due to per-tool context limit\./u);
  assert.equal(Number(commandEvents[1]?.lineReadNewLinesCovered), Number(String(commandEvents[1]?.insertedResultText || '').split(/\r?\n/u).filter((line) => /^\d+:/u.test(line)).length));
});
```

- [ ] **Step 2: Reuse fitter result for read-state accounting**

In the existing `ToolOutputFitter.fitSegments()` path, preserve the returned `fitResult.returnedLineCount` in a local:

```ts
let fittedReturnedSegmentCount: number | null = null;
...
const fitResult = await fitter.fitSegments(...);
fittedReturnedSegmentCount = fitResult.returnedLineCount;
```

Use that for `Get-Content` returned-range merge instead of counting lines from `resultText`.

- [ ] **Step 3: Keep prompt-budget hard rejection for shell `Get-Content`**

Do not run shell commands after prompt wall-clock expiry. The final bounded-read salvage is only for deterministic local read tools. Add a comment:

```ts
// Shell-backed line reads are output-budget fitted after execution, but are not run after prompt-time expiry.
```

- [ ] **Step 4: Run tests**

Run:

```powershell
npm test -- mock-repo-search-loop.test.ts --test-name-pattern "Get-Content|read window"
```

Expected:

```text
all selected tests pass
```

---

### Task 5: Summary Planner `read_lines` Budget-Aware Expansion

**Files:**
- Modify: `src/summary/planner/mode.ts`
- Test: `tests/runtime-planner-mode.test.ts`

- [ ] **Step 1: Add failing test for repeated fitted `read_lines` accounting**

Add near `planner advances repeated read_lines calls to one unread span`:

```ts
test('planner advances repeated read_lines using only returned fitted lines', async () => {
  await withTempEnv(async () => {
    const plannerConfig = {
      LlamaCpp: { NumCtx: 19000, Reasoning: 'off' },
      Runtime: { LlamaCpp: { NumCtx: 19000, Reasoning: 'off' } },
    };
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      const inputText = buildOversizedMultilinePlannerInput(getChunkThresholdCharacters(config) + 1000);

      const result = await summarizeRequest({
        question: 'Read repeated fitted ranges.',
        inputText,
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
        allowedPlannerTools: ['read_lines'],
      });

      assert.equal(result.Summary, 'advanced after fitted read');
      const secondPrompt = getChatRequestText(server.state.chatRequests[1]);
      const thirdPrompt = getChatRequestText(server.state.chatRequests[2]);
      assert.match(secondPrompt, /\d+ lines truncated due to per-tool context limit\./u);
      assert.match(thirdPrompt, /read_lines startLine=\d+ endLine=\d+ lineCount=\d+/u);
      assert.doesNotMatch(thirdPrompt, /read_lines startLine=1 endLine=4000/u);
    }, {
      config: plannerConfig,
      tokenizeTokenCount(content) {
        if (/Planner mode:/u.test(content)) return 1000;
        if (/read_lines startLine=/u.test(content)) return Math.max(1, String(content).length * 10);
        return 1000;
      },
      assistantContent(_promptText, _parsed, requestIndex) {
        if (requestIndex === 1) return JSON.stringify({ action: 'read_lines', startLine: 1, endLine: 4000 });
        if (requestIndex === 2) return JSON.stringify({ action: 'read_lines', startLine: 1, endLine: 4000 });
        if (requestIndex === 3) {
          return JSON.stringify({
            action: 'finish',
            classification: 'summary',
            raw_review_required: false,
            output: 'advanced after fitted read',
          });
        }
        throw new Error(`unexpected request ${requestIndex}`);
      },
    });
  });
});
```

- [ ] **Step 2: Preserve returned segment count from fitter**

In `src/summary/planner/mode.ts:667-705`, keep:

```ts
let fittedReturnedLineCount: number | null = null;
...
const fitResult = await fitter.fitSegments(...);
fittedReturnedLineCount = fitResult.returnedLineCount;
```

- [ ] **Step 3: Update returned range from actual fitted output**

At `src/summary/planner/mode.ts:730-738`, replace full effective range merge with:

```ts
const returnedLineCount = fittedReturnedLineCount ?? renderedLineCountFromResult;
if (returnedLineCount > 0) {
  readLinesReturnedRanges = mergeRange(readLinesReturnedRanges, {
    start: effectiveReadLinesStart,
    end: effectiveReadLinesStart + returnedLineCount,
  });
}
```

Use the existing result text line count as fallback only when the fitter was not invoked.

- [ ] **Step 4: Run summary tests**

Run:

```powershell
npm test -- runtime-planner-mode.test.ts --test-name-pattern "read_lines"
```

Expected:

```text
all selected read_lines tests pass
```

---

### Task 6: Summary Planner Prompt-Budget/Forced-Finish Audit

**Files:**
- Modify: `src/summary/planner/mode.ts`
- Test: `tests/runtime-planner-mode.test.ts`

- [ ] **Step 1: Add regression for forced-finish no-expansion**

Add this test near `planner keeps the first real tool output and rewrites one duplicate warning tool turn through x5`.

```ts
test('planner forced finish rejects read_lines before unread expansion', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const inputText = buildOversizedTransitionsInput(threshold + 1000);

      const result = await summarizeRequest({
        question: 'Force finish, then try to read lines.',
        inputText,
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(result.Classification, 'summary');
      assert.equal(result.Summary, 'forced finish after rejected read');

      const finalRequest = server.state.chatRequests[server.state.chatRequests.length - 1];
      const messages = Array.isArray(finalRequest?.messages) ? finalRequest.messages : [];
      const assistantToolMessages = messages.filter((message) => Array.isArray(message?.tool_calls));
      const lastAssistantTool = assistantToolMessages[assistantToolMessages.length - 1];
      const lastCall = lastAssistantTool?.tool_calls?.[0];
      assert.equal(String(lastCall?.function?.name || ''), 'read_lines');
      const args = JSON.parse(String(lastCall?.function?.arguments || '{}')) as { startLine?: number; endLine?: number };
      assert.equal(args.startLine, 1);
      assert.equal(args.endLine, 5);

      const toolMessages = messages.filter((message) => message?.role === 'tool');
      const lastToolContent = String(toolMessages[toolMessages.length - 1]?.content || '');
      assert.match(lastToolContent, /Current evidence is already repeating/u);
      assert.doesNotMatch(lastToolContent, /^6: /mu);
    }, {
      assistantContent(_promptText, _parsed, requestIndex) {
        if (requestIndex >= 1 && requestIndex <= 5) {
          return JSON.stringify({ action: 'find_text', query: 'NO_MATCH_ALPHA', mode: 'literal' });
        }
        if (requestIndex === 6) {
          return JSON.stringify({ action: 'read_lines', startLine: 1, endLine: 5 });
        }
        return JSON.stringify({
          action: 'finish',
          classification: 'summary',
          raw_review_required: false,
          output: 'forced finish after rejected read',
        });
      },
    });
  });
});
```

- [ ] **Step 2: Reorder forced-finish before read_lines expansion if needed**

Ensure `src/summary/planner/mode.ts:391-423` runs before `src/summary/planner/mode.ts:556-575` for every tool action. If this is already true, only keep the regression test.

- [ ] **Step 3: Run summary forced-finish tests**

Run:

```powershell
npm test -- runtime-planner-mode.test.ts --test-name-pattern "forced finish|read_lines"
```

Expected:

```text
all selected tests pass
```

---

### Task 7: Preserve Existing Non-Expansion Tool Fitting

**Files:**
- Modify tests only unless failures reveal drift:
  - `tests/mock-repo-search-loop.test.ts`
  - `tests/runtime-planner-mode.test.ts`
  - `tests/tool-loop-governor.test.ts`

- [ ] **Step 1: Keep existing `repo_rg` fitting test passing**

Run:

```powershell
npm test -- mock-repo-search-loop.test.ts --test-name-pattern "oversized rg|repo_list_files"
```

Expected:

```text
repo_rg and repo_list_files oversized-output tests pass
```

- [ ] **Step 2: Keep existing summary `find_text` fitting test passing**

Run:

```powershell
npm test -- runtime-planner-mode.test.ts --test-name-pattern "find_text output"
```

Expected:

```text
planner fits oversized find_text output and reports omitted results passes
```

- [ ] **Step 3: Do not add prompt-budget salvage for shell/search tools**

Confirm with one assertion in the existing prompt-budget test:

```ts
assert.doesNotMatch(task.commands.map((command) => command.output).join('\n'), /should not run/u);
```

Keep this unchanged. The intended policy is bounded salvage only for deterministic local read tools.

---

### Task 8: Transcript and Artifact Consistency

**Files:**
- Modify: `tests/repo-search-status-server.test.ts`
- Modify: `tests/mock-repo-search-loop.test.ts`

- [ ] **Step 1: Assert requested/executed/returned range fields**

Extend the repo-search bounded-read loop test to assert:

```ts
assert.match(String(commandEvent?.requestedCommand || ''), /startLine=300 endLine=900/u);
assert.match(String(commandEvent?.executedCommand || ''), /startLine=300 endLine=\d+/u);
assert.notEqual(commandEvent?.requestedCommand, commandEvent?.executedCommand);
```

- [ ] **Step 2: Add persisted transcript assertion**

Add a status-server mock request that triggers the bounded final native read. Parse the `repo_search_transcript` JSONL artifact and assert the assistant replay tool call has the returned `endLine`, not the requested end line.

- [ ] **Step 3: Run persisted test by name**

Run:

```powershell
npm test -- repo-search-status-server.test.ts --test-name-pattern "bounded read transcript"
```

Expected:

```text
new persisted transcript test passes
```

If unrelated managed-llama lifecycle tests fail when running the whole file, do not change managed-llama behavior in this plan.

---

### Task 9: Validation

**Files:**
- No code changes unless validation reveals a regression.

- [ ] **Step 1: Run focused repo-search tests**

```powershell
npm test -- mock-repo-search-loop.test.ts repo-search-loop.core.test.ts repo-search.test.ts
```

- [ ] **Step 2: Run focused summary planner tests**

```powershell
npm test -- runtime-planner-mode.test.ts runtime-planner-mode.tools.test.ts
```

- [ ] **Step 3: Run protocol/parser regression tests touched by transcript replay**

```powershell
npm test -- repo-search-planner-protocol.test.ts model-json.test.ts tool-loop-governor.test.ts
```

- [ ] **Step 4: Run build**

```powershell
npm run build
```

- [ ] **Step 5: Diff review through SiftKit**

```powershell
git diff -- src tests docs 2>&1 | siftkit summary --question "Summarize budget-aware tool expansion changes, identify unrelated changes, and list remaining test risks."
```

---

## Self-Review

**Spec coverage:** This plan covers all expansion-capable tools: repo-search `repo_read_file`, repo-search `Get-Content` read windows, and summary planner `read_lines`. It also preserves existing fitting behavior for non-expansion high-volume tools: `repo_rg`, `repo_list_files`, summary `find_text`, and JSON planner tools.

**Prompt-time policy:** The plan deliberately allows final bounded salvage only for deterministic local reads. Shell/search tools remain rejected after prompt wall-clock expiry to avoid spending more elapsed time after the user-visible prompt budget has expired.

**Transcript correctness:** Rejected tools do not show unreturned expansion. Accepted bounded reads replay the exact returned range.

**Read-state correctness:** Returned ranges are updated from fitter `returnedLineCount`, not requested/effective full span.

**No legacy compatibility:** No old tool protocol support is added.
