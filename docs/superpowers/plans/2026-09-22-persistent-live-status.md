# Persistent Live Status Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the web UI chat, the latest agent status update (streamed narration shown as white text) stays visible until a newer status update or the final answer replaces it.

**Architecture:** Today `reduceToolEvent` demotes a turn's `assistant_narration` row to `assistant_progress` on `tool_start`, which `chatTurns` sends into collapsed Internal Logic, so the status disappears the moment a tool starts. Remove the demotion so narration keeps its kind, and `assistant_progress` means only the raw run-progress row (tool markup; must stay hidden). `chatTurns` then treats narration as a step and gives the main slot to `answer ?? newest non-blank narration ?? last non-step`. Older narration moves into Internal Logic. Narration and progress rows are both excluded from model replay (`ReplayableChatMessageSchema`), so model context does not change.

**Tech Stack:** TypeScript, zod contracts (`packages/contracts`), React dashboard, `node:test`.

**Behavior after the change**

| Live turn state | Main slot (visible) | Internal Logic |
|---|---|---|
| narration N1, tool running | N1 | — (tool in activity ring) |
| N1, tool, narration N2 | N2 | N1 |
| N1, tool, N2 = blank | N1 | N2 |
| N1, tool, answer | answer | N1, tool |
| raw `progress` row | never | always |

Settled runs: completed runs still show the answer with narration in Internal Logic. Stopped runs with no answer show their newest narration, as undemoted narration already does today. Rows persisted before this change as `assistant_progress` stay in Internal Logic.

**Test command pattern:** `npm run build:test; node .\dist\test-runner\run-tests.js <source path>` (the runner maps source paths to compiled artifacts).

---

### Task 1: Failing E2E test in ChatTab for a persistent status

**Files:**
- Test: `dashboard/tests/chat-tab.test.tsx` (insert after the test ending at line 1716, `raw streamed model progress renders only inside closed Internal Logic`)

- [ ] **Step 1: Write the failing test**

```tsx
test('the latest status update stays visible until a newer one or the answer replaces it', () => {
  const renderSteps = (steps: LiveTranscriptStep[]) => {
    const store = buildThinkingStore({ content: 'find it', images: [], operationKind: 'repo-search', marker: 'THINK_MARKER_STATUS' }, steps);
    return render({ selectedSessionId: SESSION_B.id, selectedRuntime: store.get(SESSION_B.id), sessionRuntimes: store.getAll() });
  };
  const first: LiveTranscriptStep[] = [
    { kind: 'narration', delta: { turn: 1, offset: 0, text: 'STATUS_ONE' } },
    { kind: 'tool', tool: {
      kind: 'tool_start', toolCallId: 't1', turn: 1, maxTurns: 4,
      activityKind: 'command', activitySubject: { kind: 'none' }, command: 'TOOL_MARKER', promptTokenCount: 0,
    } },
  ];
  const second: LiveTranscriptStep[] = [...first, { kind: 'narration', delta: { turn: 2, offset: 0, text: 'STATUS_TWO' } }];

  const whileTool = renderSteps(first);
  assert.match(whileTool, /STATUS_ONE/u, 'the status stays visible while its tool runs');
  assert.match(whileTool, /Recent activity/u, 'the activity ring stays visible beside the status');

  const replaced = renderSteps(second);
  assert.match(replaced, /STATUS_TWO/u, 'a newer status takes the visible slot');
  assert.doesNotMatch(replaced, /STATUS_ONE/u, 'the older status moves into closed Internal Logic');
  assert.match(renderExpanded({ selectedSessionId: SESSION_B.id, selectedRuntime: buildThinkingStore(
    { content: 'find it', images: [], operationKind: 'repo-search', marker: 'THINK_MARKER_STATUS' }, second,
  ).get(SESSION_B.id) }), /STATUS_ONE/u);

  const answered = renderSteps([...second, { kind: 'answer', delta: { turn: 3, offset: 0, text: 'FINAL_MARKER' } }]);
  assert.match(answered, /FINAL_MARKER/u, 'the answer replaces the status');
  assert.doesNotMatch(answered, /STATUS_TWO/u, 'the replaced status moves into closed Internal Logic');
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js dashboard/tests/chat-tab.test.tsx`
Expected: FAIL on `the status stays visible while its tool runs` (narration is demoted to progress on `tool_start`).

---

### Task 2: Stop demoting narration on `tool_start` (contracts reducer)

**Files:**
- Modify: `packages/contracts/src/chat-transcript-reducer.ts:155-160` (promotion predicate), `:181` and `:188-194` and `:221` (demotion)
- Test: `tests/chat-transcript-reducer.test.ts:47-105`
- Update expectations: `tests/chat-run-projection.test.ts:167,361`, `tests/status-server-chat-stop.test.ts:429`, `tests/chat-recovery-performance.test.ts:99-100`, `tests/chat-recovery-storage-faults.test.ts:87`, `tests/chat-projection-updates.test.ts:120-140`

- [ ] **Step 1: Update and add the reducer tests**

In `tests/chat-transcript-reducer.test.ts`, rename the test at line 47 to `'chat transcript reducer keeps narration across tool starts, replaces progress, and upserts tool lifecycle state'` and change the kinds assertion at lines 92-96 to:

```ts
  assert.deepEqual(messages.map((message) => message.kind), [
    'assistant_narration',
    'assistant_progress',
    'assistant_tool_call',
  ]);
```

Add after that test:

```ts
test('narration keeps its kind across a tool start and a later answer for its turn promotes it', () => {
  let messages: ChatTranscriptMessage[] = [];
  messages = reduceChatTranscript(messages, { kind: 'narration', delta: { turn: 1, offset: 0, text: 'Reading.' } }, metadata);
  messages = reduceChatTranscript(messages, {
    kind: 'tool',
    tool: {
      kind: 'tool_start', toolCallId: 'read-1', turn: 1, maxTurns: 3,
      activityKind: 'read', activitySubject: { kind: 'none' }, command: 'read path="a.ts"', promptTokenCount: 0,
    },
  }, metadata);
  assert.deepEqual(messages.map((message) => [message.id, message.kind]), [
    ['test-narration-1', 'assistant_narration'],
    ['test-tool-read-1', 'assistant_tool_call'],
  ]);

  messages = reduceChatTranscript(messages, { kind: 'answer', delta: { turn: 1, offset: 0, text: 'Done.' } }, metadata);
  assert.deepEqual(messages.map((message) => [message.id, message.kind, message.content]), [
    ['test-narration-1', 'assistant_answer', 'Done.'],
    ['test-tool-read-1', 'assistant_tool_call', 'read path="a.ts"'],
  ]);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js tests/chat-transcript-reducer.test.ts`
Expected: both tests FAIL; actual first kind is `assistant_progress`.

- [ ] **Step 3: Remove the demotion**

In `reduceToolEvent`, delete the `narrationId` constant (line 181) and the `beforeTool` block (lines 188-194), and return:

```ts
  return upsertMessage(messages, message);
```

In `reduceTextEvent`, a narration row can no longer be `assistant_progress`, so drop that dead branch:

```ts
  const promotedNarration = event.kind === 'answer'
    ? messages.find((message) => (
      message.id === narrationId
      && (message.kind === 'assistant_narration' || message.kind === 'assistant_answer')
    ))
    : undefined;
```

- [ ] **Step 4: Run reducer tests**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js tests/chat-transcript-reducer.test.ts`
Expected: PASS.

- [ ] **Step 5: Update server tests that asserted the demotion**

These all assert narration rows that preceded a tool start. They now keep `assistant_narration`:

- `tests/chat-run-projection.test.ts:167`: `'assistant_progress',` → `'assistant_narration',`
- `tests/chat-run-projection.test.ts:361`: `message.kind === 'assistant_progress'` → `message.kind === 'assistant_narration'`
- `tests/status-server-chat-stop.test.ts:429` (the entry after `'assistant_thinking'` whose content is `'Inspecting files.'`): `'assistant_progress',` → `'assistant_narration',`. Leave line 433 (`'Step 2 of 5'`, the raw progress row) unchanged.
- `tests/chat-recovery-performance.test.ts:99-100`:

```ts
  // Narration that precedes a tool start keeps its kind, one row per turn.
  assert.equal(rows.filter(message => message.kind === 'assistant_narration').length, PERFORMANCE_MODEL_TURNS);
```

- `tests/chat-recovery-storage-faults.test.ts:87`: `message.kind === 'assistant_progress'` → `message.kind === 'assistant_narration'`
- `tests/chat-projection-updates.test.ts`: the test `'a rewrite and kind conversion use replacements while usage changes use metadata updates'` no longer converts a kind. Rename it `'a rewrite uses a replacement while usage changes use metadata updates'` and change line 136 to:

```ts
  assert.deepEqual(replaced.sort(), ['assistant_narration', 'assistant_tool_call']);
```

To keep coverage of kind conversion, add this test right after it:

```ts
test('promoting narration to the answer travels as a replacement', () => {
  const { recorder, capture } = fixture();
  recorder.recordDisplay({ kind: 'narration', delta: { turn: 1, offset: 0, text: 'first draft' } });
  const before = capture();
  recorder.recordDisplay({ kind: 'answer', delta: { turn: 1, offset: 0, text: 'final' } });
  const records = roundTrip(before, capture());
  const replaced = records.filter(record => record.kind === 'message').map(record => record.kind === 'message' ? record.message.kind : '');
  assert.deepEqual(replaced, ['assistant_answer']);
});
```

- [ ] **Step 6: Run the affected server tests**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js tests/chat-run-projection.test.ts tests/status-server-chat-stop.test.ts tests/chat-recovery-performance.test.ts tests/chat-recovery-storage-faults.test.ts tests/chat-projection-updates.test.ts tests/status-server-chat-repo-agent.test.ts`
Expected: PASS. `status-server-chat-repo-agent.test.ts:331` already filters out both kinds.

---

### Task 3: `chatTurns` gives the main slot to the newest status update

**Files:**
- Modify: `dashboard/src/lib/chatTurns.ts:25-56`
- Test: `dashboard/tests/lib/chatTurns.test.ts` (append after the test ending at line 268)

- [ ] **Step 1: Write the failing tests**

```ts
test('a live status update keeps the main slot while its tool runs', () => {
  const messages = [
    message({ id: 'n1', kind: 'assistant_narration', content: 'Reading the config.' }),
    message({ id: 'tc1', kind: 'assistant_tool_call', toolCallExecutionState: 'executing', toolCallStatus: 'running' }),
  ];
  const turns = groupMessagesIntoTurns(messages, new Set(['n1', 'tc1']));
  assert.equal(turns[0]?.main?.id, 'n1');
  assert.deepEqual(turns[0]?.steps, []);
  assert.deepEqual(turns[0]?.recentActivities.flatMap((group) => group.messages.map((tool) => tool.id)), ['tc1']);
});

test('a newer status update replaces the visible one and the older moves to Internal Logic', () => {
  const messages = [
    message({ id: 'n1', kind: 'assistant_narration', content: 'Reading the config.' }),
    message({ id: 'tc1', kind: 'assistant_tool_call' }),
    message({ id: 'n2', kind: 'assistant_narration', content: 'Editing the loader.' }),
  ];
  const turns = groupMessagesIntoTurns(messages, new Set(['n1', 'tc1', 'n2']));
  assert.equal(turns[0]?.main?.id, 'n2');
  assert.deepEqual(turns[0]?.steps.map((step) => step.id), ['n1']);
});

test('a blank status update does not replace the visible one', () => {
  const messages = [
    message({ id: 'n1', kind: 'assistant_narration', content: 'Reading the config.' }),
    message({ id: 'tc1', kind: 'assistant_tool_call' }),
    message({ id: 'n2', kind: 'assistant_narration', content: '  ' }),
  ];
  const turns = groupMessagesIntoTurns(messages, new Set(['n1', 'tc1', 'n2']));
  assert.equal(turns[0]?.main?.id, 'n1');
  assert.deepEqual(turns[0]?.steps.map((step) => step.id), ['n2']);
});

test('a status update stays visible over a later tool image', () => {
  const messages = [
    message({ id: 'n1', kind: 'assistant_narration', content: 'Inspecting the screenshot.' }),
    message({ id: 'img', kind: 'tool_image' }),
  ];
  const turns = groupMessagesIntoTurns(messages, new Set(['n1', 'img']));
  assert.equal(turns[0]?.main?.id, 'n1');
  assert.deepEqual(turns[0]?.steps.map((step) => step.id), ['img']);
});

test('the answer replaces the live status update', () => {
  const messages = [
    message({ id: 'n1', kind: 'assistant_narration', content: 'Reading the config.' }),
    message({ id: 'tc1', kind: 'assistant_tool_call' }),
    message({ id: 'ans', kind: 'assistant_answer', content: 'Done.' }),
  ];
  const turns = groupMessagesIntoTurns(messages, new Set(['n1', 'tc1', 'ans']));
  assert.equal(turns[0]?.main?.id, 'ans');
  assert.deepEqual(turns[0]?.steps.map((step) => step.id), ['n1', 'tc1']);
});

test('a settled run keeps its status updates in Internal Logic under the answer', () => {
  const messages = [
    message({ id: 'n1', kind: 'assistant_narration', content: 'Reading the config.', sourceRunId: 'run-1' }),
    message({ id: 'tc1', kind: 'assistant_tool_call', sourceRunId: 'run-1' }),
    message({ id: 'ans', kind: 'assistant_answer', content: 'Done.', sourceRunId: 'run-1' }),
  ];
  const turns = groupMessagesIntoTurns(messages, new Set());
  assert.equal(turns[0]?.main?.id, 'ans');
  assert.deepEqual(turns[0]?.steps.map((step) => step.id), ['n1', 'tc1']);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js dashboard/tests/lib/chatTurns.test.ts`
Expected: FAIL on `a blank status update does not replace the visible one` (main is `n2`) and `a status update stays visible over a later tool image` (main is `img`). The others may already pass after Task 2 because narration is currently a non-step.

- [ ] **Step 3: Implement**

In `dashboard/src/lib/chatTurns.ts`:

```ts
function isStepMessage(message: ChatMessage): boolean {
  const kind = message.kind;
  return kind === 'assistant_thinking' || kind === 'assistant_tool_call' || kind === 'assistant_narration' || kind === 'assistant_progress';
}

function isStatusUpdate(message: ChatMessage): boolean {
  return message.kind === 'assistant_narration' && message.content.trim() !== '';
}
```

```ts
function pickMainMessage(turn: ChatTurn): ChatMessage | null {
  const answer = turn.messages.find(isAnswerMessage);
  if (answer) return answer;
  // The newest status update holds the slot until a newer one or the answer replaces it.
  const statusUpdates = turn.messages.filter(isStatusUpdate);
  const status = statusUpdates[statusUpdates.length - 1];
  if (status) return status;
  // No answer or status: surface the last non-step message (e.g. a lone user_text message,
  // or the live user bubble before the assistant side starts). A run that is
  // only thinking/tool steps has no main slot.
  const nonStepMessages = turn.messages.filter((message) => !isStepMessage(message));
  return nonStepMessages[nonStepMessages.length - 1] ?? null;
}
```

Also update the comment in `finalizeTurn` (lines 83-84) to: `// Live tools belong only to the recent ring. Everything else that is not the main slot or thinking stack stays in Internal Logic.` (there is no progress bar).

- [ ] **Step 4: Run dashboard tests**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js dashboard/tests/lib/chatTurns.test.ts dashboard/tests/chat-tab.test.tsx`
Expected: PASS, including the Task 1 E2E test.

---

### Task 4: Spec sync and full validation

**Files:**
- Modify: `docs/superpowers/specs/2026-08-27-live-narration-and-tool-activity-design.md:70`

- [ ] **Step 1: Update the obsolete spec line**

Replace line 70 with:

```markdown
- A `tool_start` for that turn leaves the narration visible; it stays in the main slot until a newer non-blank narration or the answer replaces it, then moves into closed Internal Logic.
```

- [ ] **Step 2: Full validation**

Run each and confirm clean:
- `npm run build:test; node .\dist\test-runner\run-tests.js`: full suite
- `npm run test:dashboard`
- `npm run typecheck` (includes lint)
- `npm run lint`

Expected: all green. Report any failures with output.

- [ ] **Step 3: Manual check (optional, needs a running server)**

Start a repo-agent chat in the dashboard. While a tool runs, the last white narration line stays under the activity ring. It changes when the next narration streams and disappears into Internal Logic when the answer begins.

---

## Risks

- A live run crossing the deploy: its journal replays through the new reducer, so narration rows that were progress become narration. Display only; no schema change.
- If a model streams narration and then only tools for many turns, each turn's narration goes into Internal Logic as the next one arrives. This is intended.
- `chat-projection-updates` new test: if the encoder sends a kind change as something other than a `message` record, the `roundTrip` equality assert still guards correctness. Change only the `replaced` expectation, and only after confirming the encoder's actual record kind.
