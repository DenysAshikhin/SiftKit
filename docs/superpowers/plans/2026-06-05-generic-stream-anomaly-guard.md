# Generic Stream Anomaly Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shared stream anomaly guard that detects malformed/repeating output across answers, reasoning, and tool calls, stops the stream early, discards the bad payload from prompt context, and routes repo-search through the existing invalid-tool-call reprompt path.

**Architecture:** Introduce a typed reusable guard in `src/lib/stream-anomaly-guard.ts`, then wire it into repo-search streaming and parsed action execution. Keep repo-search-specific command validation separate in `src/repo-search/planner-action-anomaly-guard.ts`, but reuse the shared stream guard for content, reasoning, and tool argument deltas.

**Tech Stack:** TypeScript, Node test runner, existing `detectRecentTokenRepetition`, existing `requestPlannerAction`, existing `turn_action_invalid` / `invalid_tool_call` replay path.

---

## File Structure

- Create: `src/lib/stream-anomaly-guard.ts`
  - Owns generic stream anomaly detection for content, reasoning, JSON-like payloads, and tool argument fragments.
  - Exposes explicit classes and typed result objects.
- Create: `src/repo-search/planner-action-anomaly-guard.ts`
  - Owns repo-search-specific parsed action checks, such as repeated commands in one planner action and structural garbage appended to commands.
- Modify: `src/repo-search/planner-protocol.ts`
  - Uses `StreamAnomalyGuard` while accumulating `content`, `reasoning`, and `tool_calls[].function.arguments`.
  - Emits an explicitly invalid early-stop payload without including the bad streamed text.
- Modify: `src/repo-search/engine.ts`
  - Uses `RepoSearchPlannerActionAnomalyGuard` after parsing planner output and before any command execution.
  - Sends anomalies through the same invalid planner replay path.
- Test: `tests/stream-anomaly-guard.test.ts`
- Test: `tests/repo-search-planner-protocol.test.ts`
- Test: `tests/mock-repo-search-loop.test.ts`

Do not create a worktree. The project instructions say to avoid worktrees.

---

### Task 1: Shared Stream Anomaly Guard

**Files:**
- Create: `src/lib/stream-anomaly-guard.ts`
- Test: `tests/stream-anomaly-guard.test.ts`
- Modify: none

- [ ] **Step 1: Write failing tests for generic stream anomalies**

Add `tests/stream-anomaly-guard.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { StreamAnomalyGuard } from '../src/lib/stream-anomaly-guard.js';

test('StreamAnomalyGuard detects JSON post-closure spill for structured streams', () => {
  const guard = new StreamAnomalyGuard();
  assert.equal(guard.append({ surface: 'tool_arguments', text: '{"command":"rg -n \\"x\\" src"}' }), null);

  const detection = guard.append({ surface: 'tool_arguments', text: '}]}]}}.{' });

  assert.equal(detection?.kind, 'json_post_closure_spill');
  assert.equal(detection?.surface, 'tool_arguments');
  assert.match(detection?.reason || '', /non-whitespace content after complete JSON/u);
});

test('StreamAnomalyGuard detects compact structural repetition in answer text', () => {
  const guard = new StreamAnomalyGuard();
  const detection = guard.append({
    surface: 'content',
    text: `The answer is unavailable. ${'}]}]}}.{'.repeat(4)}`,
  });

  assert.equal(detection?.kind, 'compact_structural_repetition');
  assert.equal(detection?.surface, 'content');
});

test('StreamAnomalyGuard keeps ordinary JSON examples in answer text', () => {
  const guard = new StreamAnomalyGuard();
  const detection = guard.append({
    surface: 'content',
    text: 'Use this object: {"ok": true, "items": [1, 2, 3]}. Then continue explaining it.',
  });

  assert.equal(detection, null);
});

test('StreamAnomalyGuard keeps existing recent token repetition behavior', () => {
  const guard = new StreamAnomalyGuard();
  const detection = guard.append({
    surface: 'reasoning',
    text: `${Array.from({ length: 101 }, (_, index) => `token${index}`).join(' ')} loop loop loop loop loop loop loop loop loop loop`,
  });

  assert.equal(detection?.kind, 'recent_token_repetition');
  assert.equal(detection?.surface, 'reasoning');
});
```

- [ ] **Step 2: Run the new test and verify it fails**

Run:

```powershell
npm test -- stream-anomaly-guard.test.ts
```

Expected: fail because `src/lib/stream-anomaly-guard.ts` does not exist.

- [ ] **Step 3: Implement the shared guard**

Create `src/lib/stream-anomaly-guard.ts`:

```ts
import { detectRecentTokenRepetition } from '../repo-search/repetition-guard.js';

export type StreamSurface = 'content' | 'reasoning' | 'tool_arguments' | 'json_response';

export type StreamAnomalyKind =
  | 'json_post_closure_spill'
  | 'compact_structural_repetition'
  | 'recent_token_repetition';

export type StreamAnomalyDetection = {
  kind: StreamAnomalyKind;
  surface: StreamSurface;
  reason: string;
  safeDiagnosticText: string;
};

export type StreamAppendInput = {
  surface: StreamSurface;
  text: string;
};

type SurfaceState = {
  text: string;
  jsonDepth: number;
  jsonClosed: boolean;
  inString: boolean;
  escaping: boolean;
};

const STRUCTURAL_CHARS = new Set(['}', ']', '{', '[', '.', ',', ':']);
const STRUCTURAL_REPEAT_MIN_SEGMENT_LENGTH = 4;
const STRUCTURAL_REPEAT_MAX_SEGMENT_LENGTH = 24;
const STRUCTURAL_REPEAT_MIN_REPEATS = 3;
const STRUCTURED_SURFACES = new Set<StreamSurface>(['tool_arguments', 'json_response']);

export class StreamAnomalyGuard {
  private readonly states: Map<StreamSurface, SurfaceState> = new Map();

  append(input: StreamAppendInput): StreamAnomalyDetection | null {
    const state = this.getState(input.surface);
    const postClosureDetection = this.appendAndCheckJsonPostClosure(input.surface, state, input.text);
    if (postClosureDetection !== null) return postClosureDetection;

    state.text += input.text;

    const structuralDetection = this.detectCompactStructuralRepetition(input.surface, state.text);
    if (structuralDetection !== null) return structuralDetection;

    const tokenDetection = detectRecentTokenRepetition(state.text);
    if (tokenDetection !== null) {
      return {
        kind: 'recent_token_repetition',
        surface: input.surface,
        reason: `recent ${input.surface} tokens repeated every ${tokenDetection.periodTokens} tokens across ${tokenDetection.windowTokens} tokens`,
        safeDiagnosticText: `SiftKit stopped ${input.surface}: recent tokens repeated.`,
      };
    }

    return null;
  }

  private getState(surface: StreamSurface): SurfaceState {
    const existing = this.states.get(surface);
    if (existing) return existing;
    const created: SurfaceState = { text: '', jsonDepth: 0, jsonClosed: false, inString: false, escaping: false };
    this.states.set(surface, created);
    return created;
  }

  private appendAndCheckJsonPostClosure(surface: StreamSurface, state: SurfaceState, text: string): StreamAnomalyDetection | null {
    if (!STRUCTURED_SURFACES.has(surface)) return null;

    for (const char of text) {
      if (state.jsonClosed && char.trim().length > 0) {
        return {
          kind: 'json_post_closure_spill',
          surface,
          reason: `non-whitespace content after complete JSON in ${surface}`,
          safeDiagnosticText: `SiftKit stopped ${surface}: malformed streamed JSON continued after the object closed.`,
        };
      }

      this.advanceJsonState(state, char);
      state.text += char;
    }

    return null;
  }

  private advanceJsonState(state: SurfaceState, char: string): void {
    if (state.inString) {
      if (state.escaping) {
        state.escaping = false;
        return;
      }
      if (char === '\\') {
        state.escaping = true;
        return;
      }
      if (char === '"') state.inString = false;
      return;
    }

    if (char === '"') {
      state.inString = true;
      return;
    }
    if (char === '{' || char === '[') state.jsonDepth += 1;
    if ((char === '}' || char === ']') && state.jsonDepth > 0) state.jsonDepth -= 1;
    if (state.jsonDepth === 0 && (char === '}' || char === ']')) state.jsonClosed = true;
  }

  private detectCompactStructuralRepetition(surface: StreamSurface, text: string): StreamAnomalyDetection | null {
    const suffix = text.slice(-STRUCTURAL_REPEAT_MAX_SEGMENT_LENGTH * STRUCTURAL_REPEAT_MIN_REPEATS);
    for (let segmentLength = STRUCTURAL_REPEAT_MIN_SEGMENT_LENGTH; segmentLength <= STRUCTURAL_REPEAT_MAX_SEGMENT_LENGTH; segmentLength += 1) {
      const segment = suffix.slice(-segmentLength);
      if (!this.isCompactStructuralSegment(segment)) continue;
      const repeated = segment.repeat(STRUCTURAL_REPEAT_MIN_REPEATS);
      if (suffix.endsWith(repeated)) {
        return {
          kind: 'compact_structural_repetition',
          surface,
          reason: `compact structural segment repeated ${STRUCTURAL_REPEAT_MIN_REPEATS} times in ${surface}`,
          safeDiagnosticText: `SiftKit stopped ${surface}: compact structural text repeated.`,
        };
      }
    }
    return null;
  }

  private isCompactStructuralSegment(segment: string): boolean {
    if (segment.length < STRUCTURAL_REPEAT_MIN_SEGMENT_LENGTH) return false;
    let structuralCount = 0;
    for (const char of segment) {
      if (STRUCTURAL_CHARS.has(char)) structuralCount += 1;
    }
    return structuralCount / segment.length >= 0.8;
  }
}
```

- [ ] **Step 4: Run the new test and verify it passes**

Run:

```powershell
npm test -- stream-anomaly-guard.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit Task 1**

```powershell
git add src/lib/stream-anomaly-guard.ts tests/stream-anomaly-guard.test.ts
git commit -m "feat: add generic stream anomaly guard"
```

---

### Task 2: Repo-Search Streaming Early Stop

**Files:**
- Modify: `src/repo-search/planner-protocol.ts:19`
- Modify: `src/repo-search/planner-protocol.ts:731`
- Modify: `src/repo-search/planner-protocol.ts:772`
- Modify: `src/repo-search/planner-protocol.ts:800`
- Modify: `src/repo-search/planner-protocol.ts:823`
- Modify: `src/repo-search/planner-protocol.ts:842`
- Test: `tests/repo-search-planner-protocol.test.ts`

- [ ] **Step 1: Write failing streaming tests**

Append to `tests/repo-search-planner-protocol.test.ts`:

```ts
test('requestPlannerAction stops streamed tool arguments after JSON post-closure spill', async () => {
  const events: any[] = [];
  const server = await startPlannerServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"repo_rg","arguments":"{\\"command\\":\\"rg -n \\\\\\"x\\\\\\" src\\"}"}}]}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}]}]}}.{"}}]}}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });

  try {
    const result = await requestPlannerAction({
      endpoint: server.url,
      apiKey: null,
      model: 'test-model',
      messages: [{ role: 'user', content: 'find x' }],
      allowedToolNames: ['repo_rg'],
      toolDefinitions: resolveRepoSearchPlannerToolDefinitions(['repo_rg']),
      logger: { write: (event: any) => events.push(event) },
    });

    assert.match(result.text, /__SIFTKIT_INVALID_STREAM_ANOMALY__/u);
    assert.doesNotMatch(result.text, /rg -n/u);
    const doneEvent = events.find((event) => event.kind === 'provider_request_done');
    assert.match(String(doneEvent?.earlyTerminationReason || ''), /malformed streamed JSON continued after the object closed/u);
  } finally {
    await server.close();
  }
});

test('requestPlannerAction stops repeated compact structural answer text', async () => {
  const events: any[] = [];
  const server = await startPlannerServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: {"choices":[{"delta":{"content":"answer ${'}]}]}}.{'.repeat(4)}"}}]}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });

  try {
    const result = await requestPlannerAction({
      endpoint: server.url,
      apiKey: null,
      model: 'test-model',
      messages: [{ role: 'user', content: 'answer directly' }],
      allowedToolNames: ['finish'],
      toolDefinitions: resolveRepoSearchPlannerToolDefinitions(['finish']),
      logger: { write: (event: any) => events.push(event) },
    });

    assert.match(result.text, /__SIFTKIT_INVALID_STREAM_ANOMALY__/u);
    assert.doesNotMatch(result.text, /\}\]\}\]\}\}\.\{/u);
  } finally {
    await server.close();
  }
});
```

If `startPlannerServer` is not exported in the file, use the existing local helper pattern already used by the streaming tests in `tests/repo-search-planner-protocol.test.ts`.

- [ ] **Step 2: Run the streaming tests and verify they fail**

Run:

```powershell
npm test -- repo-search-planner-protocol.test.ts
```

Expected: the two new tests fail because stream anomalies are not wired into `requestPlannerAction`.

- [ ] **Step 3: Wire `StreamAnomalyGuard` into `requestPlannerAction`**

Modify `src/repo-search/planner-protocol.ts`:

```ts
import { StreamAnomalyGuard, type StreamAnomalyDetection } from '../lib/stream-anomaly-guard.js';
```

Add near `buildEarlyStoppedPlannerText`:

```ts
function buildInvalidStreamAnomalyPlannerText(detection: StreamAnomalyDetection): string {
  return [
    '__SIFTKIT_INVALID_STREAM_ANOMALY__',
    detection.safeDiagnosticText,
    'The streamed model response was discarded. Produce one valid planner action and do not repeat the malformed output.',
  ].join('\n');
}
```

Inside `requestPlannerAction`, near `let earlyReason`:

```ts
  const streamAnomalyGuard = new StreamAnomalyGuard();
```

When accumulating tool arguments:

```ts
                if (tc.function?.arguments) {
                  const detection = streamAnomalyGuard.append({ surface: 'tool_arguments', text: tc.function.arguments });
                  if (detection !== null) {
                    earlyReason = detection.reason;
                    earlyResolvedText = buildInvalidStreamAnomalyPlannerText(detection);
                    return 'stop';
                  }
                  toolCalls[idx].arguments += tc.function.arguments;
                }
```

When accumulating thinking/content, call the guard before existing repetition checks:

```ts
              if (deltaThinking) {
                thinkingText += deltaThinking;
                options.onThinkingDelta?.(deltaThinking);
                const detection = streamAnomalyGuard.append({ surface: 'reasoning', text: deltaThinking });
                if (detection !== null) {
                  earlyReason = detection.reason;
                  earlyResolvedText = buildInvalidStreamAnomalyPlannerText(detection);
                  return 'stop';
                }
              }
```

```ts
              if (deltaContent) {
                contentText += deltaContent;
                options.onContentDelta?.(deltaContent);
                const detection = streamAnomalyGuard.append({ surface: 'content', text: deltaContent });
                if (detection !== null) {
                  earlyReason = detection.reason;
                  earlyResolvedText = buildInvalidStreamAnomalyPlannerText(detection);
                  return 'stop';
                }
              }
```

Keep the existing `detectRecentTokenRepetition` calls until Task 5 removes duplication.

- [ ] **Step 4: Run the streaming tests and verify they pass**

Run:

```powershell
npm test -- repo-search-planner-protocol.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit Task 2**

```powershell
git add src/repo-search/planner-protocol.ts tests/repo-search-planner-protocol.test.ts
git commit -m "fix: stop malformed streamed planner output early"
```

---

### Task 3: Parsed Repo-Search Action Guard Before Execution

**Files:**
- Create: `src/repo-search/planner-action-anomaly-guard.ts`
- Modify: `src/repo-search/engine.ts:1249`
- Test: `tests/mock-repo-search-loop.test.ts`

- [ ] **Step 1: Write failing action-level tests**

Append to `tests/mock-repo-search-loop.test.ts`:

```ts
test('runTaskLoop rejects structurally spilled repo-search commands before execution', async () => {
  const executedCommands: string[] = [];
  const plannerResponses = [
    {
      text: JSON.stringify({
        action: 'tool_batch',
        tools: [
          { action: 'repo_rg', command: 'rg -n "turns|messages.*persist|persist.*messages"}]}]}}.{' },
        ],
      }),
    },
    {
      text: JSON.stringify({
        action: 'finish',
        answer: 'Malformed tool call was retried.',
        confidence: 'high',
      }),
    },
  ];

  const result = await runTaskLoop({
    task: { id: 'task-malformed-command-spill', prompt: 'find session storage' },
    repoRoot: tempRoot,
    plannerResponses,
    mockCommandResults: new Map(),
    onCommandStart: (command) => executedCommands.push(command),
  });

  assert.deepEqual(executedCommands, []);
  assert.match(JSON.stringify(result.messages), /invalid_tool_call/u);
  assert.match(result.finalOutput, /Malformed tool call was retried/u);
});

test('runTaskLoop rejects repeated command batches before execution', async () => {
  const executedCommands: string[] = [];
  const repeatedTools = [
    { action: 'repo_rg', command: 'rg -n "session.*storage|storage.*session" src' },
    { action: 'repo_rg', command: 'rg -n "session.*storage|storage.*session" src' },
    { action: 'repo_rg', command: 'rg -n "session.*storage|storage.*session" src' },
  ];

  const result = await runTaskLoop({
    task: { id: 'task-repeated-command-batch', prompt: 'find session storage' },
    repoRoot: tempRoot,
    plannerResponses: [
      { text: JSON.stringify({ action: 'tool_batch', tools: repeatedTools }) },
      { text: JSON.stringify({ action: 'finish', answer: 'Retried cleanly.', confidence: 'high' }) },
    ],
    mockCommandResults: new Map(),
    onCommandStart: (command) => executedCommands.push(command),
  });

  assert.deepEqual(executedCommands, []);
  assert.match(JSON.stringify(result.messages), /invalid_tool_call/u);
  assert.match(result.finalOutput, /Retried cleanly/u);
});
```

Adjust only helper property names to match the existing `runTaskLoop` test harness in this file.

- [ ] **Step 2: Run action-level tests and verify they fail**

Run:

```powershell
npm test -- mock-repo-search-loop.test.ts
```

Expected: fail because malformed commands are still allowed into normal execution.

- [ ] **Step 3: Implement repo-search action anomaly guard**

Create `src/repo-search/planner-action-anomaly-guard.ts`:

```ts
import type { ToolAction } from './planner-protocol.js';

export type PlannerActionAnomaly = {
  reason: string;
  diagnosticText: string;
};

const STRUCTURAL_SPILL_PATTERN = /(?:\}|\])(?:\]|\}){2,}\.\{$/u;
const REPEATED_COMMAND_THRESHOLD = 3;

export class RepoSearchPlannerActionAnomalyGuard {
  inspect(toolActions: readonly ToolAction[]): PlannerActionAnomaly | null {
    const commandCounts = new Map<string, number>();

    for (const action of toolActions) {
      const command = this.getCommandText(action);
      if (command.length === 0) continue;

      if (STRUCTURAL_SPILL_PATTERN.test(command)) {
        return {
          reason: `malformed structural spill appended to ${action.tool_name} command`,
          diagnosticText: `Rejected malformed ${action.tool_name} command before execution: structural spill after command text.`,
        };
      }

      const nextCount = (commandCounts.get(command) || 0) + 1;
      commandCounts.set(command, nextCount);
      if (nextCount >= REPEATED_COMMAND_THRESHOLD) {
        return {
          reason: `same ${action.tool_name} command repeated ${nextCount} times in one planner action`,
          diagnosticText: `Rejected repeated ${action.tool_name} command batch before execution.`,
        };
      }
    }

    return null;
  }

  private getCommandText(action: ToolAction): string {
    const command = action.args && typeof action.args === 'object' ? (action.args as { command?: unknown }).command : null;
    return typeof command === 'string' ? command.trim() : '';
  }
}
```

- [ ] **Step 4: Route action anomalies through invalid planner replay**

Modify `src/repo-search/engine.ts`:

```ts
import { RepoSearchPlannerActionAnomalyGuard } from './planner-action-anomaly-guard.js';
```

Initialize before the loop:

```ts
  const plannerActionAnomalyGuard = new RepoSearchPlannerActionAnomalyGuard();
```

After a valid parsed planner action yields tool actions, and before command execution:

```ts
    const plannerActionAnomaly = plannerActionAnomalyGuard.inspect(toolActions);
    if (plannerActionAnomaly !== null) {
      const invalidToolAction = buildInvalidToolCallActionFromResponseText(plannerActionAnomaly.diagnosticText, allowedPlannerToolNames);
      appendToolCallExchange(
        messages,
        invalidToolAction,
        plannerActionAnomaly.diagnosticText,
        buildInvalidToolCallRepromptMessage(plannerActionAnomaly.reason, allowedPlannerToolNames),
      );
      options.logger?.write({ kind: 'turn_action_invalid', taskId: task.id, turn, error: plannerActionAnomaly.reason });
      continue;
    }
```

Use the exact existing helper names in `engine.ts`; if `buildInvalidToolCallRepromptMessage` is inline today, extract a typed function in `engine.ts` and reuse it for parse failures and action anomalies.

- [ ] **Step 5: Run action-level tests and verify they pass**

Run:

```powershell
npm test -- mock-repo-search-loop.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit Task 3**

```powershell
git add src/repo-search/planner-action-anomaly-guard.ts src/repo-search/engine.ts tests/mock-repo-search-loop.test.ts
git commit -m "fix: reject malformed repo-search actions before execution"
```

---

### Task 4: Keep Bad Stream Text Out Of Prompt Context

**Files:**
- Modify: `src/repo-search/planner-protocol.ts:731`
- Modify: `src/repo-search/engine.ts:1249`
- Test: `tests/mock-repo-search-loop.test.ts`
- Test: `tests/repo-search-planner-protocol.test.ts`

- [ ] **Step 1: Write failing context-sanitization assertions**

Add assertions to the tests from Tasks 2 and 3:

```ts
assert.doesNotMatch(JSON.stringify(result), /\}\]\}\]\}\}\.\{/u);
assert.doesNotMatch(JSON.stringify(result), /turns\|messages\.\*persist/u);
assert.match(JSON.stringify(result), /__SIFTKIT_INVALID_STREAM_ANOMALY__|invalid_tool_call/u);
```

For planner-protocol tests, assert against `result.text`. For engine tests, assert against `result.messages` and `result.finalOutput`.

- [ ] **Step 2: Run focused tests and verify they fail if bad text is still replayed**

Run:

```powershell
npm test -- repo-search-planner-protocol.test.ts mock-repo-search-loop.test.ts
```

Expected: fail if any bad streamed command/text is included in replay context.

- [ ] **Step 3: Ensure safe diagnostics only**

Update the early-stop builder and action anomaly path so replay text contains only:

```text
__SIFTKIT_INVALID_STREAM_ANOMALY__
SiftKit stopped <surface>: <safe reason>.
The streamed model response was discarded. Produce one valid planner action and do not repeat the malformed output.
```

Do not include `contentText`, `thinkingText`, raw `toolCalls[].arguments`, or the original malformed command.

- [ ] **Step 4: Run focused tests and verify they pass**

Run:

```powershell
npm test -- repo-search-planner-protocol.test.ts mock-repo-search-loop.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit Task 4**

```powershell
git add src/repo-search/planner-protocol.ts src/repo-search/engine.ts tests/repo-search-planner-protocol.test.ts tests/mock-repo-search-loop.test.ts
git commit -m "fix: keep malformed stream text out of replay context"
```

---

### Task 5: Remove Duplicate Repo-Search Repetition Logic

**Files:**
- Modify: `src/repo-search/planner-protocol.ts:823`
- Modify: `src/repo-search/planner-protocol.ts:842`
- Modify: `src/repo-search/engine.ts:161`
- Test: `tests/repetition-guard.test.ts`
- Test: `tests/repo-search-planner-protocol.test.ts`

- [ ] **Step 1: Confirm existing repetition tests pass before refactor**

Run:

```powershell
npm test -- repetition-guard.test.ts repo-search-planner-protocol.test.ts
```

Expected: pass.

- [ ] **Step 2: Move stream repetition calls behind `StreamAnomalyGuard`**

Remove direct `detectRecentTokenRepetition` calls from `planner-protocol.ts` content/thinking stream handling because `StreamAnomalyGuard` now owns that generic detection.

Keep `engine.ts` tool-output repetition fitting if it is guarding executed command output rather than provider stream output.

- [ ] **Step 3: Run repetition and planner-protocol tests**

Run:

```powershell
npm test -- repetition-guard.test.ts repo-search-planner-protocol.test.ts
```

Expected: pass.

- [ ] **Step 4: Commit Task 5**

```powershell
git add src/repo-search/planner-protocol.ts tests/repo-search-planner-protocol.test.ts
git commit -m "refactor: centralize streamed repetition detection"
```

---

### Task 6: Broader Stream Surface Integration

**Files:**
- Modify: `src/status-server/chat.ts:831`
- Modify: `src/lib/llama-client.ts:91`
- Test: `tests/status-server-chat.test.ts`

- [ ] **Step 1: Write a failing direct-chat streaming test**

Add a focused test in `tests/status-server-chat.test.ts` near existing streamed chat tests:

```ts
test('streamDirectChatWebTurn stops anomalous repeated answer text before persistence', async () => {
  const badText = `answer ${'}]}]}}.{'.repeat(4)}`;
  const persistedMessages = await runMockStreamedChatTurn({
    chunks: [badText],
  });

  assert.doesNotMatch(JSON.stringify(persistedMessages), /\}\]\}\]\}\}\.\{/u);
  assert.match(JSON.stringify(persistedMessages), /SiftKit stopped content/u);
});
```

Use the existing streamed chat test helpers in `status-server-chat.test.ts`; do not add a new server harness if one already exists.

- [ ] **Step 2: Run the direct-chat test and verify it fails**

Run:

```powershell
npm test -- status-server-chat.test.ts
```

Expected: fail because direct chat does not use `StreamAnomalyGuard`.

- [ ] **Step 3: Add explicit guard usage at direct-chat streaming call site**

In `src/status-server/chat.ts`, create a `StreamAnomalyGuard` for each streamed assistant turn. On answer/content deltas:

```ts
const detection = streamAnomalyGuard.append({ surface: 'content', text: deltaText });
if (detection !== null) {
  streamedAnswerText = detection.safeDiagnosticText;
  return 'stop';
}
```

Keep the guard at the chat call site rather than inside `LlamaClient.streamChatCompletion`, because the client cannot know whether a packet is answer text, reasoning, JSON mode, or tool arguments.

- [ ] **Step 4: Run the direct-chat test and verify it passes**

Run:

```powershell
npm test -- status-server-chat.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit Task 6**

```powershell
git add src/status-server/chat.ts tests/status-server-chat.test.ts
git commit -m "fix: guard streamed chat answers against anomalies"
```

---

### Task 7: Full Validation

**Files:**
- Modify: none unless validation finds failures

- [ ] **Step 1: Run focused suite**

Run:

```powershell
npm test -- stream-anomaly-guard.test.ts repo-search-planner-protocol.test.ts mock-repo-search-loop.test.ts status-server-chat.test.ts
```

Expected: pass.

- [ ] **Step 2: Run build**

Run:

```powershell
npm run build
```

Expected: pass.

- [ ] **Step 3: Run full tests**

Run:

```powershell
npm test
```

Expected: pass.

- [ ] **Step 4: Inspect diff through SiftKit**

Run:

```powershell
git diff 2>&1 | siftkit summary --question "Review this diff for stream anomaly guard behavior. Extract behavioral changes, test coverage, and risks. Return concise findings with file anchors."
```

Expected: no unintentional behavior changes, no raw bad stream text preserved in prompt context.

- [ ] **Step 5: Commit final validation fixes if needed**

If validation required fixes:

```powershell
git add src tests
git commit -m "test: validate stream anomaly guard integration"
```

If no fixes were needed, do not create an empty commit.

---

## Self-Review

- Spec coverage: The plan covers generic stream surfaces (`content`, `reasoning`, structured JSON/tool arguments), repo-search parsed action execution, context sanitization, and direct chat answer streaming.
- Placeholder scan: No `TODO`, `TBD`, or unspecified test commands remain.
- Type consistency: `StreamAnomalyGuard`, `StreamAnomalyDetection`, `RepoSearchPlannerActionAnomalyGuard`, and `PlannerActionAnomaly` are named consistently across tasks.
- Risk: Task 6 may need minor helper adjustment because `status-server-chat.test.ts` helper names must match the existing local harness. Keep that adjustment limited to existing helper usage.
