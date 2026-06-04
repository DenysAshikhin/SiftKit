# Chat Context Fidelity (Per-Turn Thinking Bubbles) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the persisted dashboard chat 1:1 with the LLM conversation context for all UI conversation types, by persisting each planner turn's thinking as an `assistant_thinking` bubble interleaved before that turn's tool calls.

**Architecture:** Thread the real planner turn (`TaskCommand.turn`) and per-turn native reasoning (`TaskResult.turnThinking`) through the engine result. Refactor `appendChatMessagesWithUsage` to a turns-based API; build ordered turns from the result via a new `buildPersistTurnsFromRepoSearchResult`. The dashboard already renders persisted messages verbatim, so no frontend change. Engine edits only record onto the returned result (not the in-loop `messages` array), and persisted thinking is append-only/written-once, so prompt caching is preserved.

**Tech Stack:** TypeScript, Node built-in `node:test` runner (via `tsx --test`).

**Spec:** `docs/superpowers/specs/2026-06-04-chat-context-fidelity-design.md`

**Test commands:**
- Build test bundle (recompiles from `src` + `tests`; re-run after each edit): `npm run build:test`
- Run one file: `node .\dist\scripts\run-tests.js tests/<file>.test.ts`
- Run one test by name: `node .\dist\scripts\run-tests.js tests/<file>.test.ts --test-name-pattern "<name>"`
- Typecheck/build: `npm run build`

**Atomicity note:** This repo keeps no legacy/compat shims, so the `appendChatMessagesWithUsage` signature change and all five call-site updates land in one commit (Task 4) — intermediate states would not compile. Tasks 1–3 are each independently green.

## File Structure

- Modify `src/repo-search/prompts.ts` — add `turn` to `TaskCommand`.
- Modify `src/repo-search/engine.ts` — set `turn` at the 6 `commands.push` sites; declare + populate + return `turnThinking`; add `turnThinking` to `TaskResult`.
- Modify `src/repo-search/planner-protocol.ts` — mock path extracts inline `<think>` so tests can drive per-turn thinking.
- Modify `src/status-server/chat.ts` — add `PersistToolMessage` + `PersistTurn` types; add `buildToolMessageFromCommand` (fail-loud on missing turn) + `buildPersistTurnsFromRepoSearchResult`; (Task 4) refactor `appendChatMessagesWithUsage` to turns-based and remove `buildToolMessagesFromRepoSearchResult`.
- Modify `src/status-server/routes/chat.ts` — (Task 4) update all 5 `appendChatMessagesWithUsage` call sites; swap import.
- Modify `tests/status-server-chat.test.ts` and `tests/mock-repo-search-loop.test.ts` — new + updated tests.

---

### Task 1: Mock planner thinking support

**Files:**
- Modify: `src/repo-search/planner-protocol.ts:450-456`
- Test: `tests/mock-repo-search-loop.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/mock-repo-search-loop.test.ts`:

```ts
test('mock planner strips think block from response text', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  await runTaskLoop(
    { id: 'task-strip', question: 'q', signals: ['done'] },
    {
      maxTurns: 1, maxInvalidResponses: 2, minToolCallsBeforeFinish: 0,
      mockResponses: ['<think>hidden</think>{"action":"finish","output":"done"}'],
      mockCommandResults: {},
      logger: { write(event) { events.push(event); } },
    }
  );
  const response = events.find((e) => e.kind === 'turn_model_response');
  assert.equal(response?.thinkingText, 'hidden');
  assert.equal(response?.text, '{"action":"finish","output":"done"}');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test; node .\dist\scripts\run-tests.js tests/mock-repo-search-loop.test.ts --test-name-pattern "mock planner strips think block"`
Expected: FAIL — `response.thinkingText` is `''` and `response.text` still contains the `<think>` block.

- [ ] **Step 3: Implement mock inline-think extraction**

Replace `src/repo-search/planner-protocol.ts:450-456`:

```ts
  if (Array.isArray(options.mockResponses)) {
    const index = options.mockResponseIndex || 0;
    if (index >= options.mockResponses.length) {
      return { text: '', thinkingText: '', mockExhausted: true };
    }
    const rawMock = options.mockResponses[index];
    const { thinkingText, text } = rawMock.includes('<think>')
      ? extractInlineThinking(rawMock)
      : { thinkingText: '', text: rawMock };
    return { text, thinkingText, mockExhausted: false, nextMockResponseIndex: index + 1 };
  }
```

> `extractInlineThinking` is the module-private helper at `:105-114`; no import needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build:test; node .\dist\scripts\run-tests.js tests/mock-repo-search-loop.test.ts --test-name-pattern "mock planner strips think block"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/repo-search/planner-protocol.ts tests/mock-repo-search-loop.test.ts
git commit -m "feat(repo-search): extract inline think from mock planner responses"
```

---

### Task 2: Record real turn + per-turn thinking in the engine result

**Files:**
- Modify: `src/repo-search/prompts.ts:334-343`
- Modify: `src/repo-search/engine.ts` (type `:703-725`; accumulator `:816`; recording after `:1155`; 6 `commands.push` sites `:1327,:1376,:1443,:1459,:1532,:1878`; return `:2027-2041`)
- Test: `tests/mock-repo-search-loop.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/mock-repo-search-loop.test.ts`:

```ts
test('runTaskLoop records real planner turn per command and per-turn thinking', async () => {
  const result = await runTaskLoop(
    { id: 'task-turns', question: 'Find planner text.', signals: ['done'] },
    {
      maxTurns: 6,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        '<think>plan step a</think>{"action":"repo_rg","command":"rg -n \\"a\\" src"}',
        '<think>plan step b</think>{"action":"repo_rg","command":"rg -n \\"b\\" src"}',
        '<think>final reasoning</think>{"action":"finish","output":"done"}',
      ],
      mockCommandResults: {
        'rg -n "a" src': { exitCode: 0, stdout: 'a', stderr: '' },
        'rg -n "b" src': { exitCode: 0, stdout: 'b', stderr: '' },
      },
    }
  );
  assert.equal(result.commands.length, 2);
  assert.equal(result.commands[0].turn, 1);
  assert.equal(result.commands[1].turn, 2);
  assert.equal(result.turnThinking[1], 'plan step a');
  assert.equal(result.turnThinking[2], 'plan step b');
  assert.equal(result.turnThinking[3], 'final reasoning');
});

test('runTaskLoop sets turn on a duplicate-rejected command push', async () => {
  const result = await runTaskLoop(
    { id: 'task-dup-turn', question: 'Find planner text.', signals: [] },
    {
      maxTurns: 5,
      maxInvalidResponses: 3,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        '{"action":"repo_rg","command":"rg -n \\"planner\\" src"}',
        '{"action":"repo_rg","command":"rg -n \\"planner\\" src"}',
        '{"action":"finish","output":"done"}',
      ],
      mockCommandResults: {
        'rg -n "planner" src': { exitCode: 0, stdout: 'hit', stderr: '' },
      },
    }
  );
  assert.equal(result.commands.length, 2);
  assert.equal(result.commands[0].turn, 1);
  assert.equal(result.commands[1].safe, false);
  assert.equal(String(result.commands[1].reason || ''), 'duplicate command');
  assert.equal(result.commands[1].turn, 2);
});

test('runTaskLoop records turn thinking for an invalid-parse turn', async () => {
  const result = await runTaskLoop(
    { id: 'task-invalid-think', question: 'q', signals: ['done'] },
    {
      maxTurns: 5,
      maxInvalidResponses: 3,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        '<think>bad reasoning</think>not valid json',
        '<think>final</think>{"action":"finish","output":"done"}',
      ],
      mockCommandResults: {},
    }
  );
  // The invalid-parse turn (no command pushed) still records its thinking.
  assert.equal(result.turnThinking[1], 'bad reasoning');
  assert.equal(result.turnThinking[2], 'final');
});
```

> The duplicate-rejected push (`engine.ts:1376`) and the invalid-parse `continue` branch (`:1205`) are the two paths the success-only test misses; together with the success test they cover turn-setting on a rejection push and turn-thinking on a command-less turn.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build:test; node .\dist\scripts\run-tests.js tests/mock-repo-search-loop.test.ts --test-name-pattern "records real planner turn|duplicate-rejected command push|turn thinking for an invalid-parse"`
Expected: FAIL — `commands[].turn` undefined and `result.turnThinking` undefined.

- [ ] **Step 3a: Add `turn` to `TaskCommand`**

Replace `src/repo-search/prompts.ts:334-343`:

```ts
export type TaskCommand = {
  command: string;
  turn: number;
  modelVisibleCommand?: string;
  safe: boolean;
  reason: string | null;
  exitCode: number | null;
  output: string;
  promptOutput?: string;
  outputTokens?: number;
};
```

- [ ] **Step 3b: Add `turnThinking` to `TaskResult`**

In `src/repo-search/engine.ts:703-725`, add the field right after `commands: TaskCommand[];`:

```ts
  commands: TaskCommand[];
  turnThinking: Record<number, string>;
```

- [ ] **Step 3c: Declare the accumulator**

In `src/repo-search/engine.ts`, immediately after `const commands: TaskCommand[] = [];` (`:816`):

```ts
  const turnThinking: Record<number, string> = {};
```

- [ ] **Step 3d: Record per-turn thinking once per turn**

In `src/repo-search/engine.ts`, immediately after the `turn_model_response` logger write block closes (after `:1155`) and before the `if (Number.isFinite(response.promptTokens)...` accumulation (`:1157`), insert:

```ts
    const turnThinkingText = String(response.thinkingText || '').trim();
    if (turnThinkingText) {
      turnThinking[turn] = turnThinkingText;
    }
```

> This runs every turn before any `continue`/`break`, so it captures normal, invalid-parse, and finish turns.

- [ ] **Step 3e: Set `turn` at all six `commands.push` sites**

Insert `turn,` into each pushed literal, preserving all existing fields. Sites:

`:1327` → `commands.push({ command, turn, safe: false, reason: forcedReason, exitCode: null, output: \`Rejected command: ${forcedReason}\` });`

`:1376` → `commands.push({ command, turn, safe: false, reason: rejectionReason, exitCode: null, output: \`Rejected: ${duplicateMessage}\` });`

`:1443` → `commands.push({ command, turn, safe: false, reason: nativeExecution.reason, exitCode: null, output: rejection });`

`:1459` → `commands.push({ command, turn, safe: false, reason: normalized.rejectedReason || null, exitCode: null, output: rejection });`

`:1532` → `commands.push({ command: commandToRun, turn, safe: false, reason: safety.reason, exitCode: null, output: rejection });`

`:1878` (success) → add `turn,` after `command: commandToRun,`:
```ts
    commands.push({
      command: commandToRun,
      turn,
      modelVisibleCommand,
      safe: true,
      reason: null,
      exitCode: executed.exitCode,
      output: commandOutputText,
      promptOutput: resultText,
      outputTokens: resultTokenCount,
    });
```

> All six are inside `for (let turn = 1; ...)` (`:892`), so `turn` is in scope. Match the existing literals exactly; only insert `turn,`.

- [ ] **Step 3f: Return `turnThinking`**

In the `return { ... }` at `:2027`, add `turnThinking,` after `commands,`:

```ts
    invalidResponses, commandFailures, commands, turnThinking, finalOutput, passed,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build:test; node .\dist\scripts\run-tests.js tests/mock-repo-search-loop.test.ts --test-name-pattern "records real planner turn|duplicate-rejected command push|turn thinking for an invalid-parse"`
Expected: PASS

- [ ] **Step 5: Fix `TaskResult`/`TaskCommand` literal compile errors**

Run: `npm run build`
Expected: errors wherever `TaskResult`/`TaskCommand` literals omit the new required fields. Known: `tests/mock-repo-search-loop.test.ts:2071-2106` (`buildScorecard` literals) — add `turnThinking: {}` to each task literal and `turn: 1` to each command literal. Fix every reported site, then re-run `npm run build` until clean.

- [ ] **Step 6: Commit**

```bash
git add src/repo-search/prompts.ts src/repo-search/engine.ts tests/mock-repo-search-loop.test.ts
git commit -m "feat(repo-search): record real turn and per-turn thinking in task result"
```

---

### Task 3: Add the turn builder in chat.ts (additive)

**Files:**
- Modify: `src/status-server/chat.ts` (add `PersistTurn` near `:393`; add helpers after `:939`)
- Test: `tests/status-server-chat.test.ts`

> Additive only — the existing `buildToolMessagesFromRepoSearchResult` and the routes are left intact here so the commit compiles. Task 4 removes the flat builder.

- [ ] **Step 1: Write the failing test**

In `tests/status-server-chat.test.ts`, add `buildPersistTurnsFromRepoSearchResult` to the existing import from `../src/status-server/chat.ts` (keep `buildToolMessagesFromRepoSearchResult`). Append these tests (keep all existing tests):

```ts
test('buildPersistTurnsFromRepoSearchResult interleaves per-turn thinking before that turn\'s tools', () => {
  const turns = buildPersistTurnsFromRepoSearchResult({
    scorecard: {
      tasks: [{
        turnThinking: { 1: 'think one', 2: 'think two', 3: 'final think' },
        commands: [
          { command: 'rg -n "a" src --no-ignore', modelVisibleCommand: 'rg -n "a" src', turn: 1, exitCode: 0, output: 'a', promptOutput: 'a', outputTokens: 3 },
          { command: 'rg -n "b" src --no-ignore', modelVisibleCommand: 'rg -n "b" src', turn: 2, exitCode: 0, output: 'b', promptOutput: 'b', outputTokens: 4 },
        ],
      }],
    },
  });

  assert.equal(turns.length, 3);
  assert.equal(turns[0].thinkingText, 'think one');
  assert.equal(turns[0].toolMessages.length, 1);
  assert.equal(turns[0].toolMessages[0].toolCallCommand, 'rg -n "a" src');
  assert.equal(turns[0].toolMessages[0].toolCallTurn, 1);
  assert.equal(turns[1].thinkingText, 'think two');
  assert.equal(turns[1].toolMessages[0].toolCallCommand, 'rg -n "b" src');
  assert.equal(turns[2].thinkingText, 'final think');
  assert.equal(turns[2].toolMessages.length, 0);
});

test('buildPersistTurnsFromRepoSearchResult uses prompt output and tokens for tool bubbles', () => {
  const turns = buildPersistTurnsFromRepoSearchResult({
    scorecard: {
      tasks: [{
        turnThinking: {},
        commands: [{
          command: 'rg -n "tool_call" src --no-ignore',
          modelVisibleCommand: 'rg -n "tool_call" src',
          turn: 1, exitCode: 0,
          output: 'x'.repeat(10_000),
          promptOutput: 'src/repo-search/engine.ts:1613:tool_result',
          outputTokens: 295,
        }],
      }],
    },
  });
  const message = turns[0].toolMessages[0];
  assert.equal(message.toolCallOutput, 'src/repo-search/engine.ts:1613:tool_result');
  assert.equal(message.toolCallOutputSnippet, 'src/repo-search/engine.ts:1613:tool_result');
  assert.equal(message.outputTokens, 295);
});

test('buildPersistTurnsFromRepoSearchResult emits no thinking bubble for a tools-only turn', () => {
  const turns = buildPersistTurnsFromRepoSearchResult({
    scorecard: { tasks: [{
      turnsUsed: 1,
      turnThinking: {},
      commands: [{ command: 'rg -n "x" src', modelVisibleCommand: 'rg -n "x" src', turn: 1, exitCode: 0, output: 'x' }],
    }] },
  });
  assert.equal(turns.length, 1);
  assert.equal(turns[0].thinkingText, '');
  assert.equal(turns[0].toolMessages.length, 1);
});

test('buildPersistTurnsFromRepoSearchResult sets tool maxTurns from task turnsUsed', () => {
  const turns = buildPersistTurnsFromRepoSearchResult({
    scorecard: { tasks: [{
      turnsUsed: 4,
      turnThinking: {},
      commands: [{ command: 'rg -n "x" src', modelVisibleCommand: 'rg -n "x" src', turn: 2, exitCode: 0, output: 'x' }],
    }] },
  });
  assert.equal(turns[0].toolMessages[0].toolCallTurn, 2);
  assert.equal(turns[0].toolMessages[0].toolCallMaxTurns, 4);
});

test('buildPersistTurnsFromRepoSearchResult throws on a command with a missing turn', () => {
  assert.throws(() => buildPersistTurnsFromRepoSearchResult({
    scorecard: { tasks: [{
      turnsUsed: 1,
      turnThinking: {},
      commands: [{ command: 'rg -n "x" src', modelVisibleCommand: 'rg -n "x" src', exitCode: 0, output: 'x' }],
    }] },
  }), /invalid turn/u);
});
```

> The interleave fixture above omits `turnsUsed`, exercising the max-command-turn fallback; the `throws` test omits `turn`, exercising the fail-loud branch.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test; node .\dist\scripts\run-tests.js tests/status-server-chat.test.ts --test-name-pattern "buildPersistTurnsFromRepoSearchResult"`
Expected: FAIL — `buildPersistTurnsFromRepoSearchResult` is not exported.

- [ ] **Step 3a: Add the `PersistTurn` type**

In `src/status-server/chat.ts`, immediately before `type AppendChatOptions` (`:393`):

```ts
export type PersistToolMessage = {
  id: string;
  content: string;
  toolCallCommand: string;
  toolCallTurn: number;
  toolCallMaxTurns: number;
  toolCallExitCode: number | null;
  toolCallPromptTokenCount?: number | null;
  toolCallOutputSnippet: string;
  toolCallOutput: string;
  outputTokens: number | null;
};
export type PersistTurn = { thinkingText: string; toolMessages: PersistToolMessage[] };
```

- [ ] **Step 3b: Add the per-command helper + turn builder**

Insert immediately after the existing `buildToolMessagesFromRepoSearchResult` function (after `:939`) — leave that function in place for now:

```ts
function buildToolMessageFromCommand(command: Dict, turnsUsed: number): PersistToolMessage | null {
  if (!command || typeof command !== 'object') {
    return null;
  }
  const commandText = getDisplayToolCommand(command);
  if (!commandText) {
    return null;
  }
  const turn = Number(command.turn);
  if (!Number.isInteger(turn) || turn < 1) {
    // No legacy fallback: a persisted command must carry its real planner turn.
    throw new Error(`TaskCommand for "${commandText}" has an invalid turn: ${String(command.turn)}`);
  }
  const output = typeof command.promptOutput === 'string'
    ? command.promptOutput
    : typeof command.output === 'string'
      ? command.output
      : '';
  return {
    id: crypto.randomUUID(),
    content: commandText,
    toolCallCommand: commandText,
    toolCallTurn: turn,
    toolCallMaxTurns: turnsUsed,
    toolCallExitCode: Number.isFinite(Number(command.exitCode)) ? Number(command.exitCode) : null,
    toolCallPromptTokenCount: null,
    toolCallOutputSnippet: output.length > 200 ? `${output.slice(0, 200)}...` : output,
    toolCallOutput: output,
    outputTokens: getChatUsageValue(command.outputTokens),
  };
}

export function buildPersistTurnsFromRepoSearchResult(result: Dict | null | undefined): PersistTurn[] {
  const scorecard = result && typeof result.scorecard === 'object' ? result.scorecard as Dict : {};
  const tasks = Array.isArray(scorecard.tasks) ? scorecard.tasks as Dict[] : [];
  const turns: PersistTurn[] = [];
  for (const task of tasks) {
    if (!task || typeof task !== 'object') {
      continue;
    }
    const commands = Array.isArray(task.commands) ? task.commands as Dict[] : [];
    // Resolve a sane "of Y" for tool bubbles. turnsUsed must be a positive integer
    // no smaller than the largest command turn; otherwise fall back to that max
    // (never the raw command count, and never a value that would render "3 of 2").
    const commandTurns = commands
      .map((command) => Number((command as Dict).turn))
      .filter((turn) => Number.isInteger(turn) && turn >= 1);
    const maxCommandTurn = commandTurns.length ? Math.max(...commandTurns) : 0;
    const rawTurnsUsed = Number(task.turnsUsed);
    const turnsUsed = Number.isInteger(rawTurnsUsed) && rawTurnsUsed >= maxCommandTurn
      ? rawTurnsUsed
      : maxCommandTurn;
    const turnThinking = task.turnThinking && typeof task.turnThinking === 'object'
      ? task.turnThinking as Dict
      : {};
    const toolsByTurn = new Map<number, PersistToolMessage[]>();
    for (const command of commands) {
      const message = buildToolMessageFromCommand(command, turnsUsed);
      if (!message) {
        continue;
      }
      const bucket = toolsByTurn.get(message.toolCallTurn);
      if (bucket) {
        bucket.push(message);
      } else {
        toolsByTurn.set(message.toolCallTurn, [message]);
      }
    }
    const thinkingTurns = Object.keys(turnThinking)
      .map((key) => Number(key))
      .filter((turn) => Number.isFinite(turn));
    const orderedTurns = [...new Set([...toolsByTurn.keys(), ...thinkingTurns])].sort((a, b) => a - b);
    for (const turn of orderedTurns) {
      const thinkingText = String(turnThinking[String(turn)] || '').trim();
      const toolMessages = toolsByTurn.get(turn) || [];
      if (!thinkingText && toolMessages.length === 0) {
        continue;
      }
      turns.push({ thinkingText, toolMessages });
    }
  }
  return turns;
}
```

> `buildToolMessageFromCommand` throws on a missing/non-positive `turn` (no silent `0`/`null` fallback) — Task 2 guarantees the engine sets it. **Intentional behavior change:** the removed flat builder set `toolCallMaxTurns` to the per-task command count (`chat.ts:930`); the new builder sets it to `task.turnsUsed` (validated to a positive integer ≥ the max command turn). This is the correct denominator for the "turn X of Y" display — the old command-count value was misleading. Because commands are stored turn-ascending and grouping preserves within-turn order, the flattened `turns[].toolMessages` order equals `buildToolContextFromRepoSearchResult`'s order — keeping `hiddenToolContexts` aligned in Task 4.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build:test; node .\dist\scripts\run-tests.js tests/status-server-chat.test.ts --test-name-pattern "buildPersistTurnsFromRepoSearchResult"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/status-server/chat.ts tests/status-server-chat.test.ts
git commit -m "feat(status-server): build interleaved persist turns from repo-search result"
```

---

### Task 4: Refactor `appendChatMessagesWithUsage` to turns-based API + update all call sites (atomic)

**Files:**
- Modify: `src/status-server/chat.ts` (`AppendChatOptions` `:393-411`; signature `:413-421`; body `:460-563`; remove `buildToolMessagesFromRepoSearchResult` `:901-939`)
- Modify: `src/status-server/routes/chat.ts` (import `:35`; sites `:629,:763,:884,:1040,:1254`)
- Test: `tests/status-server-chat.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/status-server-chat.test.ts`: remove the now-superseded flat-builder tests (the two `buildToolMessagesFromRepoSearchResult` tests originally at `:142-181`) and the old `appendChatMessagesWithUsage preserves explicit per-tool bubble token count` test (originally at `:183-211`); drop `buildToolMessagesFromRepoSearchResult` from the import. Add:

```ts
test('appendChatMessagesWithUsage persists interleaved per-turn thinking and tools', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-chat-turns-'));
  const session = appendChatMessagesWithUsage(
    runtimeRoot,
    createSession(),
    'Find tool call handling.',
    'Tool calls are handled in engine.ts.',
    { promptTokens: 30, completionTokens: 9, thinkingTokens: 0, promptCacheTokens: null, promptEvalTokens: 30 },
    {
      turns: [
        { thinkingText: 'think one', toolMessages: [{
          id: 'tool-a', content: 'rg -n "a" src', toolCallCommand: 'rg -n "a" src',
          toolCallTurn: 1, toolCallMaxTurns: 2, toolCallExitCode: 0,
          toolCallOutputSnippet: 'snippet', toolCallOutput: 'x'.repeat(10_000), outputTokens: 295,
        }] },
        { thinkingText: 'final think', toolMessages: [] },
      ],
    }
  );

  const appended = session.messages.slice(2).map((m) => m.kind);
  assert.deepEqual(appended, [
    'user_text',
    'assistant_thinking',
    'assistant_tool_call',
    'assistant_thinking',
    'assistant_answer',
  ]);
  const toolMessage = session.messages.find((m) => m.kind === 'assistant_tool_call');
  assert.equal(toolMessage?.outputTokensEstimate, 295);
  assert.equal(toolMessage?.associatedToolTokens, 295);
});

test('appendChatMessagesWithUsage aligns hidden tool contexts with persisted tool message ids', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-chat-hidden-'));
  const session = appendChatMessagesWithUsage(
    runtimeRoot, createSession(), 'q', 'answer',
    { promptTokens: 10, completionTokens: 5, thinkingTokens: 0, promptCacheTokens: null, promptEvalTokens: 10 },
    {
      toolContextContents: ['context for a', 'context for b'],
      turns: [
        { thinkingText: '', toolMessages: [
          { id: 'tool-a', content: 'rg a', toolCallCommand: 'rg a', toolCallTurn: 1, toolCallMaxTurns: 2, toolCallExitCode: 0, toolCallOutputSnippet: 'a', toolCallOutput: 'a', outputTokens: 1 },
          { id: 'tool-b', content: 'rg b', toolCallCommand: 'rg b', toolCallTurn: 2, toolCallMaxTurns: 2, toolCallExitCode: 0, toolCallOutputSnippet: 'b', toolCallOutput: 'b', outputTokens: 1 },
        ] },
      ],
    }
  );
  const toolIds = session.messages.filter((m) => m.kind === 'assistant_tool_call').map((m) => m.id);
  const hidden = (session.hiddenToolContexts || []) as Array<{ content: string; sourceMessageId: string }>;
  assert.equal(hidden.length, 2);
  assert.equal(hidden[0].content, 'context for a');
  assert.equal(hidden[0].sourceMessageId, toolIds[0]);
  assert.equal(hidden[1].content, 'context for b');
  assert.equal(hidden[1].sourceMessageId, toolIds[1]);
});

test('appendChatMessagesWithUsage omits empty-thinking turns and persists single-turn chat', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-chat-single-'));
  const session = appendChatMessagesWithUsage(
    runtimeRoot, createSession(), 'hi', 'hello',
    { promptTokens: 5, completionTokens: 2, thinkingTokens: 1, promptCacheTokens: null, promptEvalTokens: 5 },
    { turns: [{ thinkingText: 'regular chat reasoning', toolMessages: [] }] }
  );
  assert.deepEqual(session.messages.slice(2).map((m) => m.kind), ['user_text', 'assistant_thinking', 'assistant_answer']);

  const emptySession = appendChatMessagesWithUsage(
    runtimeRoot, createSession(), 'hi', 'hello', {},
    { turns: [{ thinkingText: '', toolMessages: [] }] }
  );
  assert.deepEqual(emptySession.messages.slice(2).map((m) => m.kind), ['user_text', 'assistant_answer']);
});
```

- [ ] **Step 2: Run to verify it fails (compile)**

Run: `npm run build`
Expected: FAIL — `options.turns` not yet on `AppendChatOptions`; routes still pass the removed positional `thinkingContent`.

- [ ] **Step 3a: Update `AppendChatOptions`**

In `src/status-server/chat.ts:393-411`, remove `toolMessages?: Dict[];` and add `turns` as the first field:

```ts
type AppendChatOptions = {
  turns: PersistTurn[];
  toolContextContents?: string[];
  requestDurationMs?: number | null;
  promptEvalDurationMs?: number | null;
  generationDurationMs?: number | null;
  promptTokensPerSecond?: number | null;
  generationTokensPerSecond?: number | null;
  requestStartedAtUtc?: string | null;
  thinkingStartedAtUtc?: string | null;
  thinkingEndedAtUtc?: string | null;
  answerStartedAtUtc?: string | null;
  answerEndedAtUtc?: string | null;
  speculativeAcceptedTokens?: number | null;
  speculativeGeneratedTokens?: number | null;
  outputTokens?: number | null;
  thinkingTokens?: number | null;
  sourceRunId?: string | null;
};
```

- [ ] **Step 3b: Update the signature (drop the `thinkingContent` positional)**

Replace `src/status-server/chat.ts:413-421`:

```ts
export function appendChatMessagesWithUsage(
  runtimeRoot: string,
  session: ChatSession,
  content: string,
  assistantContent: string,
  usage: Partial<ChatUsage> = {},
  options: AppendChatOptions = { turns: [] }
): ChatSession {
```

- [ ] **Step 3c: Replace the single-thinking block + flat tool loop with the turns loop**

Replace `src/status-server/chat.ts:460-510` (the `const thinkingMessageId = ...` thinking block at `:460-476`, plus the `const toolMessages = ...` flat loop at `:477-510`) with:

```ts
  const turns = Array.isArray(options.turns) ? options.turns : [];
  const persistedToolMessageIds: string[] = [];
  for (const turn of turns) {
    const thinkingText = String(turn.thinkingText || '');
    if (thinkingText.trim()) {
      messages.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        kind: 'assistant_thinking',
        content: thinkingText,
        inputTokensEstimate: 0,
        outputTokensEstimate: 0,
        thinkingTokens: estimateTokenCount(thinkingText),
        inputTokensEstimated: false,
        outputTokensEstimated: false,
        thinkingTokensEstimated: usageThinkingTokens === null,
        createdAtUtc: now,
        sourceRunId,
      });
    }
    const turnToolMessages = Array.isArray(turn.toolMessages) ? turn.toolMessages : [];
    for (const toolMessage of turnToolMessages) {
      const toolMessageId = typeof toolMessage.id === 'string' && toolMessage.id.trim() ? toolMessage.id : crypto.randomUUID();
      const toolOutput = typeof toolMessage.toolCallOutput === 'string'
        ? toolMessage.toolCallOutput
        : typeof toolMessage.toolCallOutputSnippet === 'string'
          ? toolMessage.toolCallOutputSnippet
          : '';
      const explicitToolOutputTokens = getChatUsageValue(toolMessage.outputTokens);
      const toolOutputTokens = explicitToolOutputTokens ?? estimateTokenCount(toolOutput);
      messages.push({
        id: toolMessageId,
        role: 'assistant',
        kind: 'assistant_tool_call',
        content: typeof toolMessage.content === 'string' ? toolMessage.content : String(toolMessage.toolCallCommand || ''),
        inputTokensEstimate: 0,
        outputTokensEstimate: toolOutputTokens,
        thinkingTokens: 0,
        inputTokensEstimated: false,
        outputTokensEstimated: explicitToolOutputTokens === null,
        thinkingTokensEstimated: false,
        promptEvalTokens: Number.isFinite(Number(toolMessage.toolCallPromptTokenCount)) ? Number(toolMessage.toolCallPromptTokenCount) : null,
        associatedToolTokens: toolOutputTokens,
        toolCallCommand: typeof toolMessage.toolCallCommand === 'string' ? toolMessage.toolCallCommand : String(toolMessage.content || ''),
        toolCallTurn: Number.isFinite(Number(toolMessage.toolCallTurn)) ? Number(toolMessage.toolCallTurn) : null,
        toolCallMaxTurns: Number.isFinite(Number(toolMessage.toolCallMaxTurns)) ? Number(toolMessage.toolCallMaxTurns) : null,
        toolCallExitCode: Number.isFinite(Number(toolMessage.toolCallExitCode)) ? Number(toolMessage.toolCallExitCode) : null,
        toolCallPromptTokenCount: Number.isFinite(Number(toolMessage.toolCallPromptTokenCount)) ? Number(toolMessage.toolCallPromptTokenCount) : null,
        toolCallOutputSnippet: typeof toolMessage.toolCallOutputSnippet === 'string' ? toolMessage.toolCallOutputSnippet : '',
        toolCallOutput: toolOutput,
        createdAtUtc: now,
        sourceRunId,
      });
      persistedToolMessageIds.push(toolMessageId);
    }
  }
```

> This reproduces the existing tool-push body (`:487-509`) verbatim inside the per-turn loop. Diff against current source to confirm every `toolCall*` field at `:498-506` is preserved. The `assistant_answer` push (`:511-550`) is unchanged, including the vestigial `thinkingContent: ''` at `:547`.

- [ ] **Step 3d: Join hidden tool contexts via the flattened ids**

Replace the hidden-context loop at `src/status-server/chat.ts:551-563`:

```ts
  for (let index = 0; index < toolContextContents.length; index += 1) {
    const sourceMessageId = persistedToolMessageIds[index] || assistantMessageId;
    hiddenToolContexts.push({
      id: crypto.randomUUID(),
      content: toolContextContents[index],
      tokenEstimate: estimateTokenCount(toolContextContents[index]),
      sourceMessageId,
      createdAtUtc: now,
    });
  }
```

- [ ] **Step 3e: Remove the flat `buildToolMessagesFromRepoSearchResult`**

Delete the entire `buildToolMessagesFromRepoSearchResult` function (`:901-939`). `buildToolMessageFromCommand` + `buildPersistTurnsFromRepoSearchResult` (added in Task 3) replace it.

- [ ] **Step 3f: Swap the routes import**

In `src/status-server/routes/chat.ts:35` (the import from `../chat`), replace `buildToolMessagesFromRepoSearchResult` with `buildPersistTurnsFromRepoSearchResult`. Keep `buildToolContextFromRepoSearchResult`.

- [ ] **Step 3g: Update the two regular-chat sites (single turn)**

Site `:629` — drop the `thinkingContent` positional; add `turns`:

```ts
      const sessionWithTelemetry = appendChatMessagesWithUsage(runtimeRoot, activeSession, userContent, assistantContent, usage, {
        turns: [{ thinkingText: thinkingContent, toolMessages: [] }],
        requestDurationMs: Date.now() - startedAt,
        requestStartedAtUtc,
        speculativeAcceptedTokens: speculativeMetrics.speculativeAcceptedTokens,
        speculativeGeneratedTokens: speculativeMetrics.speculativeGeneratedTokens,
      });
```

Site `:763`:

```ts
      const updatedSession = appendChatMessagesWithUsage(runtimeRoot, activeSession, userContent, generated.assistantContent, generated.usage, {
        turns: [{ thinkingText: generated.thinkingContent, toolMessages: [] }],
        requestDurationMs: Date.now() - startedAt,
        requestStartedAtUtc: phaseTimestamps.requestStartedAtUtc,
        thinkingStartedAtUtc: phaseTimestamps.thinkingStartedAtUtc,
        thinkingEndedAtUtc: phaseTimestamps.thinkingEndedAtUtc,
        answerStartedAtUtc: phaseTimestamps.answerStartedAtUtc,
        answerEndedAtUtc: phaseTimestamps.answerEndedAtUtc,
        speculativeAcceptedTokens: speculativeMetrics.speculativeAcceptedTokens,
        speculativeGeneratedTokens: speculativeMetrics.speculativeGeneratedTokens,
      });
```

- [ ] **Step 3h: Update the three planner sites (`:884`, `:1040`, `:1254`)**

At each site: delete the `const toolMessages = buildToolMessagesFromRepoSearchResult(result);` line, remove the `'',` positional `thinkingContent` argument, and replace the `toolMessages: toolMessages.map(...)` option with the `turns:` option below. At `:884` the call becomes:

```ts
      const updatedSession = appendChatMessagesWithUsage(
        runtimeRoot,
        { ...activeSession, presetId: preset?.id || activeSession.presetId || 'plan', mode: 'plan', planRepoRoot: resolvedRepoRoot },
        content,
        assistantContent,
        {
          promptTokens: getScorecardTotal(result?.scorecard, 'promptTokens'),
          promptCacheTokens: getScorecardTotal(result?.scorecard, 'promptCacheTokens'),
          promptEvalTokens: getScorecardTotal(result?.scorecard, 'promptEvalTokens'),
        },
        {
          turns: buildPersistTurnsFromRepoSearchResult(result).map((turn) => ({
            thinkingText: turn.thinkingText,
            toolMessages: turn.toolMessages.map((message) => ({
              ...message,
              toolCallPromptTokenCount: getScorecardTotal(result?.scorecard, 'promptTokens'),
            })),
          })),
          toolContextContents,
          requestDurationMs: Date.now() - startedAt,
          promptEvalDurationMs: getScorecardTotal(result?.scorecard, 'promptEvalDurationMs'),
          generationDurationMs: getScorecardTotal(result?.scorecard, 'generationDurationMs'),
          promptTokensPerSecond: (() => {
            const promptTokens = getScorecardTotal(result?.scorecard, 'promptEvalTokens');
            const promptDurationMs = getScorecardTotal(result?.scorecard, 'promptEvalDurationMs');
            return getPromptTokensPerSecond(promptTokens, promptDurationMs);
          })(),
          generationTokensPerSecond: (() => {
            return getRepoSearchGenerationTokensPerSecond(result?.scorecard);
          })(),
          speculativeAcceptedTokens: speculativeMetrics.speculativeAcceptedTokens,
          speculativeGeneratedTokens: speculativeMetrics.speculativeGeneratedTokens,
          outputTokens: getScorecardTotal(result?.scorecard, 'outputTokens'),
          thinkingTokens: getScorecardTotal(result?.scorecard, 'thinkingTokens'),
          sourceRunId: String(result.requestId || ''),
        }
      );
```

Apply the identical transformation at `:1040` (`/plan/stream`) and `:1254` (`/repo-search/stream`): delete their `const toolMessages = ...` lines, drop the `'',` positional, swap `toolMessages:` for the same `turns: buildPersistTurnsFromRepoSearchResult(result).map(...)` block, and keep every other option exactly as-is (including `...phaseTracker.snapshot()` at the two streaming sites). Their `onProgress`/`writeSse` thinking handling is unchanged — live streaming still works; persistence now comes from `turnThinking` in the result.

- [ ] **Step 4: Build and run the full suite**

Run: `npm run build`
Expected: clean — no references to `buildToolMessagesFromRepoSearchResult`, no positional-arg type errors.

Run: `npm run build:test; node .\dist\scripts\run-tests.js tests/status-server-chat.test.ts`
Expected: PASS (including the existing replay tests at `:75-140`).

- [ ] **Step 5: Commit**

```bash
git add src/status-server/chat.ts src/status-server/routes/chat.ts tests/status-server-chat.test.ts
git commit -m "feat(status-server): persist per-turn thinking bubbles across all chat endpoints"
```

---

### Task 5: Caching-safety + replay-fidelity regression test

**Files:**
- Test: `tests/status-server-chat.test.ts`

- [ ] **Step 1: Write the test**

Add to `tests/status-server-chat.test.ts`:

```ts
test('persisted planner turns replay 1:1 into the model request and are deterministic', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-chat-replay-'));
  const base = createSession();
  base.messages = [];
  const session = appendChatMessagesWithUsage(
    runtimeRoot,
    base,
    'find the answer',
    'final markdown answer',
    { promptTokens: 10, completionTokens: 5, thinkingTokens: 2, promptCacheTokens: null, promptEvalTokens: 10 },
    {
      turns: [
        { thinkingText: 'turn one reasoning', toolMessages: [{
          id: 'tool-x', content: 'rg -n "x" src', toolCallCommand: 'rg -n "x" src',
          toolCallTurn: 1, toolCallMaxTurns: 1, toolCallExitCode: 0,
          toolCallOutputSnippet: 'hit', toolCallOutput: 'hit', outputTokens: 2,
        }] },
        { thinkingText: 'final reasoning', toolMessages: [] },
      ],
    }
  );

  const request = buildChatCompletionRequest(createConfig(), session, 'next question');
  const messages = request.body.messages as Array<Record<string, unknown>>;
  const assistantTexts = messages.filter((m) => m.role === 'assistant').map((m) => m.content);
  assert.deepEqual(assistantTexts, [
    'turn one reasoning',
    'Tool call: rg -n "x" src\n\nResult:\nhit',
    'final reasoning',
    'final markdown answer',
  ]);

  // Determinism: identical session yields identical request (prompt-caching safe).
  const again = buildChatCompletionRequest(createConfig(), session, 'next question');
  assert.deepEqual(again.body.messages, request.body.messages);
});

test('repo-search result persists and replays 1:1 through the builder', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-chat-e2e-'));
  const base = createSession();
  base.messages = [];
  const result = {
    requestId: 'run-1',
    scorecard: { tasks: [{
      turnsUsed: 2,
      turnThinking: { 1: 'reason about a', 2: 'final reason' },
      commands: [
        { command: 'rg -n "a" src --no-ignore', modelVisibleCommand: 'rg -n "a" src', turn: 1, exitCode: 0, output: 'a', promptOutput: 'a', outputTokens: 2 },
      ],
    }] },
  };
  const session = appendChatMessagesWithUsage(
    runtimeRoot, base, 'find a', 'final markdown',
    { promptTokens: 10, completionTokens: 5, thinkingTokens: 2, promptCacheTokens: null, promptEvalTokens: 10 },
    { turns: buildPersistTurnsFromRepoSearchResult(result), toolContextContents: [] }
  );
  const request = buildChatCompletionRequest(createConfig(), session, 'next');
  const assistantTexts = (request.body.messages as Array<Record<string, unknown>>)
    .filter((m) => m.role === 'assistant').map((m) => m.content);
  assert.deepEqual(assistantTexts, [
    'reason about a',
    'Tool call: rg -n "a" src\n\nResult:\na',
    'final reason',
    'final markdown',
  ]);
});
```

> The end-to-end test exercises the real persistence path (`buildPersistTurnsFromRepoSearchResult(result)` → `appendChatMessagesWithUsage` → `buildChatCompletionRequest`), confirming the builder output replays 1:1 with the model-visible command.

- [ ] **Step 2: Run tests to verify they pass**

Run: `npm run build:test; node .\dist\scripts\run-tests.js tests/status-server-chat.test.ts --test-name-pattern "replay 1:1|through the builder"`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/status-server-chat.test.ts
git commit -m "test(status-server): assert planner thinking replays 1:1 and deterministically"
```

---

### Task 6: Full verification

- [ ] **Step 1: Typecheck/build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 2: Full test suite**

Run: `npm run build:test; node .\dist\scripts\run-tests.js`
Expected: all PASS. Investigate any failure before claiming done (superpowers:verification-before-completion).

- [ ] **Step 3: Manual smoke (recommended)**

Start the dashboard, run a repo-search, and confirm: after completion the thinking bubbles remain, interleaved before each turn's tool calls, and reloading the session shows the same bubbles.
