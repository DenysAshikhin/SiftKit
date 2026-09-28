# Chat Runtime External Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A streamed token re-renders only the live transcript and the live context meter, never `App`, `useChatController`, or the ChatTab shell and its persisted history.

**Architecture:** The immutable `ChatSessionRuntimeStore` moves out of React state into a subscribable `ChatRuntimeHub`. Components read slices through `useChatRuntimeSelector` (built on `useSyncExternalStore`, cached per store identity plus equality), so a slice re-renders only when its value really changes. The snapshot reducer shares unchanged values so slow slices stay identical across token frames. ChatTab splits into a shell (slow slices), persisted segments (props only), `LiveTranscript` (per-token), and small live context meter components.

**Tech Stack:** React 19 (`useSyncExternalStore`), TypeScript, zod, node:test + jsdom + @testing-library/react, esbuild test bundles.

**Repo rules that apply to every task (from the user's CLAUDE.md):** TypeScript only, inferred end to end; no `any`, no explicit `unknown` (lint-enforced), no `as` casts, no `!`, no namespace imports. TDD for every behaviour change. Complete replacements only, with no shims, compatibility props or parallel paths (e.g. do not keep `selectedRuntime` alongside `runtimeHub`). Comments 1-2 lines. **Do not commit**; the user commits. No worktrees.

**Commands:**
- Build test bundles (required after any change, before running tests): `npm run build:test`
- Run named test files: `node ./dist/test-runner/run-tests.js <name> [<name>...]` (name = test file basename without extension, e.g. `chat-tab`)
- Full dashboard suite: `node ./dist/test-runner/run-tests.js --dashboard`
- Typecheck + lint (lint runs at the end of typecheck): `npm run typecheck`

**Background / measured baseline (2026-09-28 session):** Every server stream frame produces a `snapshot` transition applied with `setRuntimeStore` at the top of `useChatSessions`, which re-renders `App`, every controller hook, and the whole `ChatTab` per token. Markdown re-parsing is already memoized (`dashboard/src/components/MarkdownContent.tsx`: `MarkdownContent`, `MarkdownBlocks`), so the remaining per-token cost is React reconciliation of the full tree (~400 ms of script per 10 s at 60 tokens/s on the largest local session) plus a whole-message zod re-parse per `append_text` record in `ChatOperationProjection`.

**Test helper already available:** `dashboard/tests/render-tracker.ts` exports `countRenders(elementType, action)`. It counts how many times components of a given element type rendered while `action` ran, using React's DevTools commit hook. `dashboard/tests/react-test-environment.ts` imports it first, so any test that imports `./react-test-environment.js` first can use it.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `dashboard/src/lib/chat-session-runtime-store.ts` | Modify | Snapshot reducer shares unchanged `activity` / `warnings` values. |
| `dashboard/src/lib/chat-runtime-hub.ts` | Create | `ChatRuntimeHub`: the one mutable holder of the store, plus subscribe/notify. |
| `dashboard/src/hooks/useChatRuntimeSelector.ts` | Create | `useChatRuntimeSelector(hub, select, isEqual)`: cached `useSyncExternalStore` slice. |
| `dashboard/src/lib/chat-runtime-selectors.ts` | Create | Named selectors + equality for the ChatTab shell and live components. |
| `dashboard/src/lib/chat-session-state.ts` | Modify | `isSessionBusy` / `hasActiveRepoAgentRun` accept the fields they read (`Pick`), so the shell slice fits. |
| `dashboard/src/lib/compaction-segments.ts` | Modify | `refoldsEarlierRows(live)`: whether live rows can re-fold persisted rows. |
| `dashboard/src/hooks/useChatSessions.ts` | Modify | Owns a `ChatRuntimeHub` instead of `useState` for the store; returns `runtimeHub`. |
| `dashboard/src/hooks/useChatController.ts` | Modify | Passes `runtimeHub`; callbacks read `runtimeHub.getStore()` when called. |
| `dashboard/src/hooks/useChatScroll.ts` | Modify | Exports `useFollowWhilePinned`; `useChatScroll` returns `pinnedToBottomRef` and no longer takes the live signature. |
| `dashboard/src/tabs/ChatTab.tsx` | Modify | Prop `runtimeHub` replaces `selectedRuntime` / `sessionRuntimes`. The shell reads slow slices; new `LiveTranscript`, `LiveContextBar`, `LiveContextLabel`, `LiveChatStatsBar`. |
| `dashboard/src/lib/chat-operation-projection.ts` | Modify | `append_text` merges typed, without a whole-message zod parse. |
| Tests | Create/Modify | `tests/chat-runtime-hub.test.ts`, `tests/hooks/useChatRuntimeSelector.test.tsx`, `tests/chat-runtime-selectors.test.ts`, `tests/lib/compaction-segments.test.ts`, `tests/chat-session-runtime-store.test.ts`, `tests/hooks/useChatSessions.test.tsx`, `tests/chat-tab.test.tsx`, `tests/chat-operation-projection.test.ts` (all under `dashboard/`). |

---

### Task 1: Snapshot reducer shares unchanged values

A snapshot transition rewrites `activity` (a new object every frame) and `warnings` (the projection copies the array every transfer). Both must keep their previous identity when equal, or every shell slice changes per token.

**Files:**
- Modify: `dashboard/src/lib/chat-session-runtime-store.ts` (the `case 'snapshot':` branch of `applyTransition`, currently around lines 141-158)
- Test: `dashboard/tests/chat-session-runtime-store.test.ts`

- [ ] **Step 1: Write the failing test** (append to `dashboard/tests/chat-session-runtime-store.test.ts`; reuse that file's existing snapshot fixture import. It already builds snapshots via `chatSnapshot` from `./chat-snapshot-fixture.js`. If the local helper name differs, use the file's existing one.)

```ts
test('a snapshot that changes only text keeps activity and warnings identical', () => {
  const operationId = '4f9c1f9a-0000-4000-8000-0000000000c1';
  const first = chatSnapshot({ sessionId: 's1', operationId, cursor: { operationId, sequence: 1 }, warnings: ['careful'],
    messages: [createLiveMessage('a', 'assistant_answer', 'assistant', 'he')] });
  const second = { ...first, cursor: { operationId, sequence: 2 }, warnings: ['careful'],
    messages: [createLiveMessage('a', 'assistant_answer', 'assistant', 'hello')] };
  const store = new ChatSessionRuntimeStore().ensureSession('s1', '')
    .apply({ kind: 'snapshot', sessionId: 's1', snapshot: first });
  const next = store.apply({ kind: 'snapshot', sessionId: 's1', snapshot: second });
  assert.equal(next.get('s1').activity, store.get('s1').activity);
  assert.equal(next.get('s1').warnings, store.get('s1').warnings);
  assert.notEqual(next.get('s1').liveMessages, store.get('s1').liveMessages);
});

test('a snapshot with a new warning or activity replaces them', () => {
  const operationId = '4f9c1f9a-0000-4000-8000-0000000000c2';
  const first = chatSnapshot({ sessionId: 's1', operationId, cursor: { operationId, sequence: 1 }, warnings: [] });
  const store = new ChatSessionRuntimeStore().ensureSession('s1', '')
    .apply({ kind: 'snapshot', sessionId: 's1', snapshot: first });
  const next = store.apply({ kind: 'snapshot', sessionId: 's1',
    snapshot: { ...first, cursor: { operationId, sequence: 2 }, warnings: ['late'], terminalCause: 'completed' } });
  assert.deepEqual(next.get('s1').warnings, ['late']);
  assert.deepEqual(next.get('s1').activity, { kind: 'idle' });
});
```

- [ ] **Step 2: Run to verify failure.** `npm run build:test && node ./dist/test-runner/run-tests.js chat-session-runtime-store`. Expected: the first new test FAILS on the `activity` identity assertion.

- [ ] **Step 3: Implement.** In `chat-session-runtime-store.ts`, add these helpers above `applyTransition`:

```ts
function sameActivity(left: ChatSessionActivity, right: ChatSessionActivity): boolean {
  if (left.kind === 'idle' || right.kind === 'idle') return left.kind === right.kind;
  if (left.kind === 'remote' || right.kind === 'remote') return left.kind === right.kind && left.operationKind === right.operationKind;
  return left.operationKind === right.operationKind && left.operationId === right.operationId;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
```

In the `case 'snapshot':` branch, replace the `return { ...runtime, journalSnapshot: snapshot, ... };` statement (everything after `const activity: ChatSessionActivity = ...;`) with:

```ts
      // Token frames rebuild these values; keeping equal ones identical lets slow subscribers skip the frame.
      return { ...runtime, journalSnapshot: snapshot, recoveryStatus: snapshot.status,
        activity: sameActivity(runtime.activity, activity) ? runtime.activity : activity,
        liveMessages: snapshot.messages,
        awaitingResponse: false, submittedInput: runtime.submittedInput,
        pendingApproval: snapshot.approval?.actionable ? snapshot.approval : null,
        tokenTurns: new Map(snapshot.tokenTurns.map(turn => [turn.turn, { prompt: turn.prompt, usage: turn.usage }])),
        liveTokenBase: [...snapshot.tokenTurns].reverse().find(turn => turn.prompt !== null)?.prompt ?? null,
        streamedCharsSinceBase: snapshot.streamedCharsSinceBase,
        warnings: sameStrings(runtime.warnings, snapshot.warnings) ? runtime.warnings : snapshot.warnings,
        error: snapshot.status === 'recovery_failed' ? 'Chat recovery requires repair before continuing.' : null };
```

(Identical to today's object except `activity` and `warnings`.)

- [ ] **Step 4: Run to verify pass.** Same command. Expected: all tests in the file PASS.

---

### Task 2: `ChatRuntimeHub`

**Files:**
- Create: `dashboard/src/lib/chat-runtime-hub.ts`
- Test: `dashboard/tests/chat-runtime-hub.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatRuntimeHub } from '../src/lib/chat-runtime-hub';
import { ChatSessionRuntimeStore } from '../src/lib/chat-session-runtime-store';

test('apply replaces the store and notifies each subscriber once', () => {
  const hub = new ChatRuntimeHub(new ChatSessionRuntimeStore().ensureSession('s1', ''));
  let notified = 0;
  const unsubscribe = hub.subscribe(() => { notified += 1; });
  const before = hub.getStore();
  hub.apply({ kind: 'draft', sessionId: 's1', draft: 'hi' });
  assert.notEqual(hub.getStore(), before);
  assert.equal(hub.getStore().get('s1').draft, 'hi');
  assert.equal(notified, 1);
  unsubscribe();
  hub.apply({ kind: 'draft', sessionId: 's1', draft: 'again' });
  assert.equal(notified, 1);
});

test('an update that returns the same store notifies nobody', () => {
  const hub = new ChatRuntimeHub(new ChatSessionRuntimeStore().ensureSession('s1', ''));
  let notified = 0;
  hub.subscribe(() => { notified += 1; });
  hub.update((store) => store.ensureSession('s1', ''));
  assert.equal(notified, 0);
});

test('a new hub starts with an empty store', () => {
  assert.equal(new ChatRuntimeHub().getStore().getAll().length, 0);
});
```

- [ ] **Step 2: Run to verify failure.** `npm run build:test`. Expected: build FAILS (module `chat-runtime-hub` not found). That is the red state.

- [ ] **Step 3: Implement** `dashboard/src/lib/chat-runtime-hub.ts`:

```ts
import { ChatSessionRuntimeStore, type ChatSessionRuntimeTransition } from './chat-session-runtime-store';

/** The one mutable holder of chat runtime state; React reads it through useChatRuntimeSelector, never as component state. */
export class ChatRuntimeHub {
  private store: ChatSessionRuntimeStore;
  private readonly listeners = new Set<() => void>();

  constructor(store: ChatSessionRuntimeStore = new ChatSessionRuntimeStore()) {
    this.store = store;
  }

  // Arrow properties: useSyncExternalStore needs stable function identities.
  getStore = (): ChatSessionRuntimeStore => this.store;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Replaces the store with `next(current)`; subscribers hear only real changes. */
  update(next: (store: ChatSessionRuntimeStore) => ChatSessionRuntimeStore): void {
    const updated = next(this.store);
    if (updated === this.store) return;
    this.store = updated;
    for (const listener of this.listeners) listener();
  }

  apply(transition: ChatSessionRuntimeTransition): void {
    this.update((store) => store.apply(transition));
  }
}
```

- [ ] **Step 4: Run to verify pass.** `npm run build:test && node ./dist/test-runner/run-tests.js chat-runtime-hub`. Expected: 3 PASS.

---

### Task 3: `useChatRuntimeSelector`

**Files:**
- Create: `dashboard/src/hooks/useChatRuntimeSelector.ts`
- Test: `dashboard/tests/hooks/useChatRuntimeSelector.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { countRenders } from '../render-tracker.js';
import { render } from '../react-test-environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { ChatRuntimeHub } from '../../src/lib/chat-runtime-hub';
import { ChatSessionRuntimeStore } from '../../src/lib/chat-session-runtime-store';
import { useChatRuntimeSelector } from '../../src/hooks/useChatRuntimeSelector';

function DraftProbe({ hub }: { hub: ChatRuntimeHub }) {
  const draft = useChatRuntimeSelector(hub, (store) => store.get('s1').draft);
  return <span data-testid="draft">{draft}</span>;
}

function hubWithSession(): ChatRuntimeHub {
  return new ChatRuntimeHub(new ChatSessionRuntimeStore().ensureSession('s1', ''));
}

test('re-renders when the selected slice changes and shows the new value', async () => {
  const hub = hubWithSession();
  const view = render(<DraftProbe hub={hub} />);
  try {
    const renders = await countRenders(DraftProbe, async () => {
      await act(async () => hub.apply({ kind: 'draft', sessionId: 's1', draft: 'hello' }));
    });
    assert.equal(renders, 1);
    assert.equal(view.getByTestId('draft').textContent, 'hello');
  } finally { view.unmount(); }
});

test('does not re-render when another slice of the store changes', async () => {
  const hub = hubWithSession();
  const view = render(<DraftProbe hub={hub} />);
  try {
    const renders = await countRenders(DraftProbe, async () => {
      await act(async () => hub.apply({ kind: 'plan-inputs', sessionId: 's1', planRepoRootInput: 'C:/x', planMaxTurnsInput: '5' }));
    });
    assert.equal(renders, 0);
  } finally { view.unmount(); }
});

function WarningsProbe({ hub }: { hub: ChatRuntimeHub }) {
  // A fresh array every call: only the equality function keeps it from re-rendering.
  const warnings = useChatRuntimeSelector(hub, (store) => [...store.get('s1').warnings],
    (left, right) => left.length === right.length && left.every((value, index) => value === right[index]));
  return <span>{warnings.join(',')}</span>;
}

test('an equality function suppresses re-renders for equal derived values', async () => {
  const hub = hubWithSession();
  const view = render(<WarningsProbe hub={hub} />);
  try {
    const renders = await countRenders(WarningsProbe, async () => {
      await act(async () => hub.apply({ kind: 'draft', sessionId: 's1', draft: 'x' }));
    });
    assert.equal(renders, 0);
  } finally { view.unmount(); }
});
```

- [ ] **Step 2: Run to verify failure.** `npm run build:test`. Expected: build FAILS (module not found).

- [ ] **Step 3: Implement** `dashboard/src/hooks/useChatRuntimeSelector.ts`:

```ts
import { useRef, useSyncExternalStore } from 'react';
import type { ChatRuntimeHub } from '../lib/chat-runtime-hub';
import type { ChatSessionRuntimeStore } from '../lib/chat-session-runtime-store';

type Cached<T> = { store: ChatSessionRuntimeStore; select: (store: ChatSessionRuntimeStore) => T; value: T };

/**
 * One slice of the chat runtime, re-rendering only when `isEqual` says the slice changed. The
 * selection is cached per store and selector, so equal derived values keep their identity.
 */
export function useChatRuntimeSelector<T>(
  hub: ChatRuntimeHub,
  select: (store: ChatSessionRuntimeStore) => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
): T {
  const cache = useRef<Cached<T> | null>(null);
  const getSnapshot = (): T => {
    const store = hub.getStore();
    const cached = cache.current;
    if (cached && cached.store === store && cached.select === select) return cached.value;
    const selected = select(store);
    const value = cached && isEqual(cached.value, selected) ? cached.value : selected;
    cache.current = { store, select, value };
    return value;
  };
  return useSyncExternalStore(hub.subscribe, getSnapshot, getSnapshot);
}
```

- [ ] **Step 4: Run to verify pass.** `npm run build:test && node ./dist/test-runner/run-tests.js useChatRuntimeSelector`. Expected: 3 PASS.

---

### Task 4: Named runtime selectors

**Files:**
- Create: `dashboard/src/lib/chat-runtime-selectors.ts`
- Modify: `dashboard/src/lib/chat-session-state.ts` (parameter types of `isSessionBusy`, `hasActiveRepoAgentRun`)
- Test: `dashboard/tests/chat-runtime-selectors.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatSessionRuntimeStore } from '../src/lib/chat-session-runtime-store';
import { createLiveMessage } from '../src/lib/chat-live-messages';
import { chatSnapshot } from './chat-snapshot-fixture.js';
import {
  sameShellRuntime, selectLiveMessages, selectLiveOperationId, selectShellRuntime, selectStreamedCharsSinceBase,
} from '../src/lib/chat-runtime-selectors';

const OPERATION_ID = '4f9c1f9a-0000-4000-8000-0000000000d1';

function streamed(text: string, sequence: number): ChatSessionRuntimeStore {
  return new ChatSessionRuntimeStore().ensureSession('s1', '').apply({ kind: 'snapshot', sessionId: 's1',
    snapshot: chatSnapshot({ sessionId: 's1', operationId: OPERATION_ID, cursor: { operationId: OPERATION_ID, sequence },
      messages: [createLiveMessage('a', 'assistant_answer', 'assistant', text)] }) });
}

test('the shell slice is equal across token frames and differs on a slow-field change', () => {
  const first = streamed('he', 1);
  const second = first.apply({ kind: 'snapshot', sessionId: 's1', snapshot: {
    ...chatSnapshot({ sessionId: 's1', operationId: OPERATION_ID, cursor: { operationId: OPERATION_ID, sequence: 2 },
      messages: [createLiveMessage('a', 'assistant_answer', 'assistant', 'hello')] }) } });
  assert.equal(sameShellRuntime(selectShellRuntime(first, 's1'), selectShellRuntime(second, 's1')), true);
  const drafted = second.apply({ kind: 'draft', sessionId: 's1', draft: 'x' });
  assert.equal(sameShellRuntime(selectShellRuntime(second, 's1'), selectShellRuntime(drafted, 's1')), false);
});

test('selectors read an unknown session as empty values', () => {
  const store = new ChatSessionRuntimeStore();
  assert.equal(selectShellRuntime(store, 'ghost'), null);
  assert.deepEqual(selectLiveMessages(store, 'ghost'), []);
  assert.equal(selectLiveOperationId(store, 'ghost'), null);
  assert.equal(selectStreamedCharsSinceBase(store, 'ghost'), 0);
});

test('the shell slice omits every per-token field', () => {
  const shell = selectShellRuntime(streamed('he', 1), 's1');
  assert.ok(shell);
  for (const field of ['journalSnapshot', 'liveMessages', 'tokenTurns', 'streamedCharsSinceBase']) assert.equal(field in shell, false);
});
```

- [ ] **Step 2: Run to verify failure.** `npm run build:test`. Expected: build FAILS (module not found).

- [ ] **Step 3: Implement** `dashboard/src/lib/chat-runtime-selectors.ts`:

```ts
import type { ChatOperationSnapshot } from '@siftkit/contracts';
import type { ChatMessage } from '../types';
import type { ChatSessionRuntime, ChatSessionRuntimeStore } from './chat-session-runtime-store';

/** Runtime fields a stream frame rewrites on every token; only live components read them. */
export type ChatShellRuntime = Omit<ChatSessionRuntime, 'journalSnapshot' | 'liveMessages' | 'tokenTurns' | 'streamedCharsSinceBase'>;

const SHELL_KEYS = [
  'sessionId', 'recoveryStatus', 'queue', 'activity', 'error', 'warnings', 'contextUsage', 'liveTokenBase', 'draft',
  'pendingImages', 'submittedInput', 'submissionPhase', 'ownedSubmissionId', 'awaitingResponse', 'planRepoRootInput',
  'planMaxTurnsInput', 'pendingApproval', 'repoAgentApprovalMode',
] as const satisfies readonly (keyof ChatShellRuntime)[];
// Compile-time completeness: a shell field missing from SHELL_KEYS makes this line a type error.
const SHELL_KEYS_COMPLETE: [Exclude<keyof ChatShellRuntime, (typeof SHELL_KEYS)[number]>] extends [never] ? true : never = true;
void SHELL_KEYS_COMPLETE;

const NO_MESSAGES: readonly ChatMessage[] = [];

export function selectRuntime(store: ChatSessionRuntimeStore, sessionId: string): ChatSessionRuntime | null {
  return store.has(sessionId) ? store.get(sessionId) : null;
}

export function selectShellRuntime(store: ChatSessionRuntimeStore, sessionId: string): ChatShellRuntime | null {
  const runtime = selectRuntime(store, sessionId);
  if (!runtime) return null;
  const { journalSnapshot, liveMessages, tokenTurns, streamedCharsSinceBase, ...shell } = runtime;
  return shell;
}

export function sameShellRuntime(left: ChatShellRuntime | null, right: ChatShellRuntime | null): boolean {
  if (left === null || right === null) return left === right;
  return SHELL_KEYS.every((key) => Object.is(left[key], right[key]));
}

export function selectLiveMessages(store: ChatSessionRuntimeStore, sessionId: string): readonly ChatMessage[] {
  return selectRuntime(store, sessionId)?.liveMessages ?? NO_MESSAGES;
}

export function selectLiveOperationId(store: ChatSessionRuntimeStore, sessionId: string): string | null {
  return selectRuntime(store, sessionId)?.journalSnapshot?.operationId ?? null;
}

export function selectCompactedEarlierHistory(store: ChatSessionRuntimeStore, sessionId: string): boolean {
  return selectRuntime(store, sessionId)?.journalSnapshot?.compactedEarlierHistory ?? false;
}

export function selectStreamedCharsSinceBase(store: ChatSessionRuntimeStore, sessionId: string): number {
  return selectRuntime(store, sessionId)?.streamedCharsSinceBase ?? 0;
}

/** The projection keeps an unchanged approval's identity across frames, so Object.is equality holds per token. */
export function selectActionableApproval(store: ChatSessionRuntimeStore, sessionId: string): NonNullable<ChatOperationSnapshot['approval']> | null {
  const approval = selectRuntime(store, sessionId)?.journalSnapshot?.approval ?? null;
  return approval?.actionable ? approval : null;
}

export function selectActionableQuestion(store: ChatSessionRuntimeStore, sessionId: string): NonNullable<ChatOperationSnapshot['question']> | null {
  const question = selectRuntime(store, sessionId)?.journalSnapshot?.question ?? null;
  return question?.actionable ? question : null;
}

export function selectQuestionId(store: ChatSessionRuntimeStore, sessionId: string): string | null {
  return selectRuntime(store, sessionId)?.journalSnapshot?.question?.questionId ?? null;
}
```

In `dashboard/src/lib/chat-session-state.ts`, narrow the two parameter types (bodies unchanged):

```ts
export function isSessionBusy(runtime: Pick<ChatSessionRuntime, 'activity' | 'pendingApproval' | 'submissionPhase'> | null): boolean {
export function hasActiveRepoAgentRun(runtime: Pick<ChatSessionRuntime, 'activity'> | null): boolean {
```

- [ ] **Step 4: Run to verify pass.** `npm run build:test && node ./dist/test-runner/run-tests.js chat-runtime-selectors chat-session-state`. Expected: all PASS. Then `npm run typecheck`. Expected: exit 0 (confirms the completeness check and the `Pick` narrowing compile).

---

### Task 5: `useChatSessions` owns a hub

Mechanical replacement: the hook stops holding the store in React state.

**Files:**
- Modify: `dashboard/src/hooks/useChatSessions.ts`
- Test: `dashboard/tests/hooks/useChatSessions.test.tsx`

- [ ] **Step 1: Write the failing test** (append to `dashboard/tests/hooks/useChatSessions.test.tsx`)

```tsx
test('runtime transitions never re-render the hook that owns the hub', async () => {
  let renders = 0;
  const hook = renderHook(() => {
    renders += 1;
    return useChatSessions({ initialSelectedSessionId: 's-preselected', refreshToken: 0,
      buildCreateSessionRequest: () => null, confirmDeleteSession: () => true, enqueueToast: () => {} });
  });
  const hub = hook.result.current.runtimeHub;
  hub.update((store) => store.ensureSession('s-preselected', ''));
  const before = renders;
  await act(async () => {
    hub.apply({ kind: 'draft', sessionId: 's-preselected', draft: 'typing' });
    hub.apply({ kind: 'begin', sessionId: 's-preselected', operationKind: 'message', operationId: OPERATION_ID });
  });
  assert.equal(renders, before);
  assert.equal(hook.result.current.runtimeHub.getStore().get('s-preselected').draft, 'typing');
  hook.unmount();
});
```

(If the file's fetch stubbing requires a fixture for the initial listing, wrap the body in the file's existing `ChatFetchFixture` with `session: SESSION` and use `'s1'` as the id, exactly like the neighbouring tests.)

- [ ] **Step 2: Run to verify failure.** `npm run build:test`. Expected: build FAILS (`runtimeHub` does not exist on the hook result).

- [ ] **Step 3: Implement in `useChatSessions.ts`**

1. Replace these two lines:
```ts
  const [runtimeStore, setRuntimeStore] = useState<ChatSessionRuntimeStore>(new ChatSessionRuntimeStore());
  const runtimeStoreRef = useLatest(runtimeStore);
```
with:
```ts
  // Runtime state lives outside React so a streamed token re-renders only its subscribers.
  const [runtimeHub] = useState(() => new ChatRuntimeHub());
```
2. Replace every `setRuntimeStore(` call with `runtimeHub.update(`. The updater functions stay byte-for-byte the same. Where the updater is a single `.apply(x)`, you may write `runtimeHub.apply(x)` instead.
3. Replace every read of `runtimeStoreRef.current` and every read of the render-time `runtimeStore` variable (`readRuntimeInputs`, `answerQuestion`, `shouldQueue`, `queueMessage`, `forceQueue`, `setRepoAgentApprovalMode`, `stopOperation`, `recordSessionError`, the idle branch of the attach effect) with `runtimeHub.getStore()`.
4. In the returned object replace `runtimeStore,` with `runtimeHub,`.
5. Imports: add `import { ChatRuntimeHub } from '../lib/chat-runtime-hub';`; change the store import to `import type { ChatSessionRuntimeTransition } from '../lib/chat-session-runtime-store';` if `ChatSessionRuntimeStore` is no longer referenced; keep `useLatest` only if still used (lint fails on unused imports).

- [ ] **Step 4: Migrate existing hook tests.** In `dashboard/tests/hooks/useChatSessions.test.tsx`, replace every `hook.result.current.runtimeStore.` with `hook.result.current.runtimeHub.getStore().` (≈20 sites; `waitFor` polls, so no re-render is needed).

- [ ] **Step 5: Run to verify pass.** `npm run build:test && node ./dist/test-runner/run-tests.js useChatSessions`. Expected: all PASS, including the new test.

---

### Task 6: `useChatController` passes the hub

**Files:**
- Modify: `dashboard/src/hooks/useChatController.ts`

This task compiles only together with Task 9 (ChatTab props). Do the edits now; Task 9 Step 9 verifies them.

- [ ] **Step 1: Remove `selectedRuntime`.** Delete the whole `const selectedRuntime = chatSessionsHook.selectedSessionId ? (() => { ... })() : null;` block.

- [ ] **Step 2: Read the runtime when called.** Add under the other derived values:

```ts
  const runtimeHub = chatSessionsHook.runtimeHub;
  /** Read at call time: the controller no longer re-renders per runtime change, so a captured runtime would be stale. */
  function readSelectedRuntime(): ChatSessionRuntime | null {
    return selectRuntime(runtimeHub.getStore(), chatSessionsHook.selectedSessionId);
  }
```

Then in `tabProps`:
- replace `selectedRuntime,` and `sessionRuntimes: chatSessionsHook.runtimeStore.getAll(),` with `runtimeHub,`
- `onChangePlanRepoRoot`: `const runtime = readSelectedRuntime(); if (!chatSessionsHook.selectedSessionId || !runtime) return; chatSessionsHook.setSessionPlanInputs(chatSessionsHook.selectedSessionId, value, runtime.planMaxTurnsInput);`
- `onChangePlanMaxTurns`: same shape, passing `runtime.planRepoRootInput, value`
- `onSavePlanRepoRoot`: `() => chatSessionsHook.savePlanRepoRoot(readSelectedRuntime()?.planRepoRootInput ?? '', selectedChatPreset?.id)`

Imports: `import { selectRuntime } from '../lib/chat-runtime-selectors';` and `import type { ChatSessionRuntime } from '../lib/chat-session-runtime-store';`.

---

### Task 7: Scroll following moves to the live subtree

**Files:**
- Modify: `dashboard/src/hooks/useChatScroll.ts`

- [ ] **Step 1: Implement.** Replace the signature and the follow effect:

```ts
export type UseChatScrollResult = {
  chatLogRef: React.RefObject<HTMLDivElement | null>;
  pinnedToBottomRef: React.RefObject<boolean>;
  onChatLogScroll(): void;
  jumpToBottom(): void;
  showJumpToBottom: boolean;
};

/** Keeps the log at the bottom while the user is pinned there, each time `signature` changes. */
export function useFollowWhilePinned(
  chatLogRef: React.RefObject<HTMLDivElement | null>,
  pinnedToBottomRef: React.RefObject<boolean>,
  signature: string,
): void {
  useEffect(() => {
    if (pinnedToBottomRef.current) scrollChatLogToBottom(chatLogRef.current);
  }, [signature]);
}

export function useChatScroll(
  sessionId: string,
  persistedMessageIdsKey: string,
  pendingApprovalId: string | null,
): UseChatScrollResult {
```

Inside `useChatScroll`, delete the old `useEffect(() => { if (pinnedToBottomRef.current) ... }, [visibleMessageIdsKey, liveMessageScrollSignature]);`, call `useFollowWhilePinned(chatLogRef, pinnedToBottomRef, persistedMessageIdsKey);` in its place, and return `pinnedToBottomRef` in the result object. The existing ChatTab test `streaming follows only while the user is pinned to the bottom` verifies this in Task 8.

---

### Task 8: Compaction boundary rule

Live rows re-fold persisted ones only when the live run streams a compaction summary. Otherwise, rendering persisted segments then live segments equals segmenting the combined list.

**Files:**
- Modify: `dashboard/src/lib/compaction-segments.ts`
- Test: `dashboard/tests/lib/compaction-segments.test.ts`

- [ ] **Step 1: Write the failing test** (append; the file already has message helpers, reuse its `message`/`msg` builder, adapting names to the file)

```ts
import { buildCompactionSegments, refoldsEarlierRows } from '../../src/lib/compaction-segments';

/** Segments as rendered: fold boundaries and message order, ignoring how adjacent message runs are keyed. */
function renderedShape(segments: ReturnType<typeof buildCompactionSegments>): string[] {
  const shape: string[] = [];
  for (const segment of segments) {
    if (segment.kind === 'compaction') shape.push(`fold(${segment.summary?.id ?? 'orphan'}:${segment.originals.map((m) => m.id).join(',')})`);
    else shape.push(...segment.messages.map((m) => m.id));
  }
  return shape;
}

test('without a live compaction summary, persisted then live segments render like the combined list', () => {
  const persisted = [msg({ id: 'p1' }), msg({ id: 'p2', compressedIntoSummary: true }), msg({ id: 'p3' })];
  const live = [msg({ id: 'l1' }), msg({ id: 'l2' })];
  assert.equal(refoldsEarlierRows(live), false);
  assert.deepEqual(
    [...renderedShape(buildCompactionSegments(persisted)), ...renderedShape(buildCompactionSegments(live))],
    renderedShape(buildCompactionSegments([...persisted, ...live])),
  );
});

test('a streamed compaction summary re-folds earlier rows', () => {
  assert.equal(refoldsEarlierRows([msg({ id: 's', kind: 'compaction_summary' })]), true);
});
```

- [ ] **Step 2: Run to verify failure.** `npm run build:test`. Expected: build FAILS (`refoldsEarlierRows` not exported).

- [ ] **Step 3: Implement** (append to `compaction-segments.ts`):

```ts
/** Only a streamed summary folds rows before it, so without one persisted segments never depend on live rows. */
export function refoldsEarlierRows(live: readonly ChatMessage[]): boolean {
  return live.some((message) => message.kind === 'compaction_summary');
}
```

- [ ] **Step 4: Run to verify pass.** `npm run build:test && node ./dist/test-runner/run-tests.js compaction-segments`. Expected: PASS.

---

### Task 9: ChatTab reads slices; `LiveTranscript` takes the per-token work

**Files:**
- Modify: `dashboard/src/tabs/ChatTab.tsx`
- Test: `dashboard/tests/chat-tab.test.tsx`

- [ ] **Step 1: Write the failing isolation test** (append to `dashboard/tests/chat-tab.test.tsx`; `buildProps`, `SESSION_A`, `msg`, `chatSnapshot`, `createLiveMessage`, `OPERATION_ID` already exist in the file. Add `import { countRenders } from './render-tracker.js';` after the `react-test-environment` import and `import { ChatRuntimeHub } from '../src/lib/chat-runtime-hub';`.)

```tsx
test('streamed tokens re-render the live transcript but never the ChatTab shell', async () => {
  const history = Array.from({ length: 30 }, (_, index) => msg({ id: `h${index}`, kind: 'assistant_answer', content: `**answer ${index}**` }));
  const session = { ...SESSION_A, messages: history };
  const hub = new ChatRuntimeHub(buildDefaultStore(SESSION_A.id));
  const frame = (text: string, sequence: number) => ({ kind: 'snapshot' as const, sessionId: SESSION_A.id,
    snapshot: chatSnapshot({ sessionId: SESSION_A.id, operationId: OPERATION_ID, cursor: { operationId: OPERATION_ID, sequence },
      messages: [createLiveMessage('live-answer', 'assistant_answer', 'assistant', text)] }) });
  await act(async () => hub.apply(frame('Hel', 1)));
  const view = renderComponent(<ChatTab {...buildProps({ selectedSession: session, runtimeHub: hub })} />);
  try {
    const shellRenders = await countRenders(ChatTab, async () => {
      for (let sequence = 2; sequence <= 6; sequence += 1) {
        await act(async () => hub.apply(frame(`Hel${'lo'.repeat(sequence)}`, sequence)));
      }
    });
    assert.equal(shellRenders, 0);
    await waitFor(() => assert.match(view.container.textContent ?? '', /Hellolololololo/u));
  } finally { view.unmount(); }
});
```

(`as const` is allowed by the repo rules. If the file does not import `waitFor`, add it to the `./react-test-environment.js` import.)

- [ ] **Step 2: Run to verify failure.** `npm run build:test`. Expected: build FAILS (`runtimeHub` is not a ChatTab prop).

- [ ] **Step 3: Change the props contract.** In `ChatTabProps`, delete `selectedRuntime: ChatSessionRuntime | null;` and `sessionRuntimes: ChatSessionRuntime[];` and add `runtimeHub: ChatRuntimeHub;`. In the `ChatTab({ ... })` destructuring, replace `selectedRuntime, sessionRuntimes,` with `runtimeHub,`.

- [ ] **Step 4: Session indicators read the store.** Replace `buildSessionIndicators(sessions, sessionRuntimes)` and its definition with:

```ts
function buildSessionIndicators(sessions: ChatSessionSummary[], store: ChatSessionRuntimeStore): ChatSessionIndicatorView[] {
  return sessions.map((session) => ({ sessionId: session.id, indicator: deriveSessionIndicator(session, selectRuntime(store, session.id)) }));
}

function sameSessionIndicators(left: ChatSessionIndicatorView[], right: ChatSessionIndicatorView[]): boolean {
  return left.length === right.length
    && left.every((view, index) => view.sessionId === right[index]?.sessionId && view.indicator === right[index]?.indicator);
}
```

and in the component: `const sessionIndicators = useChatRuntimeSelector(runtimeHub, (store) => buildSessionIndicators(sessions, store), sameSessionIndicators);`

- [ ] **Step 5: Shell slices.** Replace the block from `const planRepoRootInput = selectedRuntime?.planRepoRootInput ?? '';` through `const liveMessageScrollSignature = buildLiveMessageScrollSignature(liveMessages);` and the `useChatScroll(...)` call with:

```tsx
  const shell = useChatRuntimeSelector(runtimeHub, (store) => selectShellRuntime(store, selectedSessionId), sameShellRuntime);
  const liveOperationId = useChatRuntimeSelector(runtimeHub, (store) => selectLiveOperationId(store, selectedSessionId));
  const compactedEarlierHistory = useChatRuntimeSelector(runtimeHub, (store) => selectCompactedEarlierHistory(store, selectedSessionId));
  const liveRefoldsHistory = useChatRuntimeSelector(runtimeHub, (store) => refoldsEarlierRows(selectLiveMessages(store, selectedSessionId)));
  const actionableApproval = useChatRuntimeSelector(runtimeHub, (store) => selectActionableApproval(store, selectedSessionId));
  const actionableQuestion = useChatRuntimeSelector(runtimeHub, (store) => selectActionableQuestion(store, selectedSessionId));
  const questionId = useChatRuntimeSelector(runtimeHub, (store) => selectQuestionId(store, selectedSessionId));
  const planRepoRootInput = shell?.planRepoRootInput ?? '';
  const planMaxTurnsInput = shell?.planMaxTurnsInput ?? '';
  const contextUsage = shell?.contextUsage ?? null;
  const liveTokenBase = shell?.liveTokenBase ?? null;
  const recoveryBlocked = shell?.recoveryStatus === 'recovery_failed';
  const chatError = shell?.error ?? (recoveryBlocked ? 'Conversation recovery needs repair before you can continue. Saved messages remain available.' : null);
  const warnings = shell?.warnings ?? [];
  const draft = shell?.draft ?? '';
  const pendingImages = shell?.pendingImages ?? [];
  const effectiveImagePixelCeiling = contextUsage?.effectiveImagePixelCeiling ?? null;
  const savedMessages = selectedSession ? selectedSession.messages : NO_MESSAGES;
  const persistedMessages = React.useMemo(() => markEarlierRunsCompacted(
    liveOperationId ? savedMessages.filter((message) => message.sourceRunId !== liveOperationId) : savedMessages,
    compactedEarlierHistory,
  ), [savedMessages, liveOperationId, compactedEarlierHistory]);
  const retainedIds = React.useMemo(() => new Set(persistedMessages.map((message) => message.id)), [persistedMessages]);
  // A streamed compaction summary folds persisted rows, so the live transcript then renders them too.
  const persistedSegments = React.useMemo(
    () => liveRefoldsHistory ? [] : buildCompactionSegments(persistedMessages), [persistedMessages, liveRefoldsHistory]);
  const persistedVisible = persistedMessages.filter((message) => message.kind !== 'compaction_summary' && message.compressedIntoSummary !== true);
  const promptContext = selectedSession?.promptContext ?? null;
  const { chatLogRef, pinnedToBottomRef, onChatLogScroll, jumpToBottom, showJumpToBottom } = useChatScroll(
    selectedSessionId,
    persistedVisible.map((message) => message.id).join('|'),
    shell?.pendingApproval?.approvalId ?? questionId,
  );
```

Add a module constant `const NO_MESSAGES: ChatMessage[] = [];` near the other top-level constants. Then, throughout the rest of `ChatTab`:
- `isSessionBusy(selectedRuntime)` → `isSessionBusy(shell)`
- `selectedRuntime?.queue` → `shell?.queue`; `selectedRuntime?.activity.kind === 'local'` → `shell?.activity.kind === 'local'`
- `selectedRuntime?.awaitingResponse` → `shell?.awaitingResponse`; `selectedRuntime?.submissionPhase` → `shell?.submissionPhase`
- the repo-agent approval-mode control: `chatMode === 'repo-agent' && shell ? (... value={shell.repoAgentApprovalMode} disabled={shell.activity.kind !== 'idle' && !hasActiveRepoAgentRun(shell)} ...)`
- `hasCompactableHistory = persistedVisible.length > 0` (a run in progress already disables Compact through `selectedSessionBusy`)
- delete `liveMessages`, `liveTokenDisplays`, `snapshot`, `currentMessages`, `segments`, `visibleMessages`, `liveMessageIds`, `visibleMessageIds`, `pendingUserMessageId` (all move to `LiveTranscript`)

- [ ] **Step 6: Render persisted segments, then the live transcript.** Replace the `{segments.map((segment) => ...)}` block inside `.msgs` with:

```tsx
              {persistedSegments.map((segment) => segment.kind === 'compaction' ? (
                <CompactedHistoryPanel key={segment.key} compactedMessages={segment.originals} summary={segment.summary}
                  sessionId={selectedSessionId} isDirectChatMode={isDirectChatMode} chatBusy={selectedSessionBusy}
                  onDeleteMessage={onDeleteMessage} onDeleteMessageImage={onDeleteMessageImage} onDeleteTurn={onDeleteTurn} />
              ) : (
                <TurnList key={segment.key} messages={segment.messages} liveMessageIds={NO_IDS} liveTokenDisplays={NO_TOKEN_DISPLAYS}
                  sessionId={selectedSessionId} pendingUserMessageId={null} isDirectChatMode={isDirectChatMode} chatBusy={selectedSessionBusy}
                  onDeleteMessage={onDeleteMessage} onDeleteMessageImage={onDeleteMessageImage} onDeleteTurn={onDeleteTurn} />
              ))}
              <LiveTranscript runtimeHub={runtimeHub} sessionId={selectedSessionId}
                leadingMessages={liveRefoldsHistory ? persistedMessages : NO_MESSAGES} retainedIds={retainedIds}
                isDirectChatMode={isDirectChatMode} chatBusy={selectedSessionBusy}
                chatLogRef={chatLogRef} pinnedToBottomRef={pinnedToBottomRef}
                onDeleteMessage={onDeleteMessage} onDeleteMessageImage={onDeleteMessageImage} onDeleteTurn={onDeleteTurn} />
```

with module constants `const NO_IDS: ReadonlySet<string> = new Set();` and `const NO_TOKEN_DISPLAYS: ReadonlyMap<string, TokenDisplay> = new Map();`. Replace the approval/question cards' `selectedRuntime?.journalSnapshot?.approval?.actionable ? (... key={selectedRuntime.journalSnapshot.approval.approvalId} approval={selectedRuntime.journalSnapshot.approval} ...)` with `actionableApproval ? (<RepoAgentApprovalCard key={actionableApproval.approvalId} approval={actionableApproval} ... />)`, and the question card likewise with `actionableQuestion`.

Add the component next to `TurnList`:

```tsx
/** The running operation's rows: the only transcript part that subscribes to per-token runtime changes. */
function LiveTranscript({ runtimeHub, sessionId, leadingMessages, retainedIds, isDirectChatMode, chatBusy, chatLogRef, pinnedToBottomRef,
  onDeleteMessage, onDeleteMessageImage, onDeleteTurn }: {
  runtimeHub: ChatRuntimeHub;
  sessionId: string;
  leadingMessages: ChatMessage[];
  retainedIds: ReadonlySet<string>;
  isDirectChatMode: boolean;
  chatBusy: boolean;
  chatLogRef: React.RefObject<HTMLDivElement | null>;
  pinnedToBottomRef: React.RefObject<boolean>;
  onDeleteMessage(messageId: string): Promise<void>;
  onDeleteMessageImage(messageId: string, imageIndex: number): Promise<void>;
  onDeleteTurn(messageIds: string[]): Promise<void>;
}) {
  const runtime = useChatRuntimeSelector(runtimeHub, (store) => selectRuntime(store, sessionId));
  const liveMessages = React.useMemo(
    () => (runtime?.liveMessages ?? NO_MESSAGES).filter((message) => !retainedIds.has(message.id)), [runtime, retainedIds]);
  const liveMessageIds = React.useMemo(() => new Set(liveMessages.map((message) => message.id)), [liveMessages]);
  const liveTokenDisplays = React.useMemo(() => runtime ? buildLiveTokenDisplays(runtime) : NO_TOKEN_DISPLAYS, [runtime]);
  useFollowWhilePinned(chatLogRef, pinnedToBottomRef, buildLiveMessageScrollSignature(liveMessages));
  const pendingUserMessageId = runtime?.awaitingResponse ? LIVE_USER_MESSAGE_ID : null;
  return buildCompactionSegments([...leadingMessages, ...liveMessages]).map((segment) => segment.kind === 'compaction' ? (
    <CompactedHistoryPanel key={`live:${segment.key}`} compactedMessages={segment.originals} summary={segment.summary}
      sessionId={sessionId} isDirectChatMode={isDirectChatMode} chatBusy={chatBusy}
      onDeleteMessage={onDeleteMessage} onDeleteMessageImage={onDeleteMessageImage} onDeleteTurn={onDeleteTurn} />
  ) : (
    <TurnList key={`live:${segment.key}`} messages={segment.messages} liveMessageIds={liveMessageIds} liveTokenDisplays={liveTokenDisplays}
      sessionId={sessionId} pendingUserMessageId={pendingUserMessageId} isDirectChatMode={isDirectChatMode} chatBusy={chatBusy}
      onDeleteMessage={onDeleteMessage} onDeleteMessageImage={onDeleteMessageImage} onDeleteTurn={onDeleteTurn} />
  ));
}
```

Note: `buildLiveTokenDisplays` takes `ChatSessionRuntime`; `runtime` here is the full runtime, so its signature is unchanged.

- [ ] **Step 7: Live context meter components.** `streamedCharsSinceBase` changes per token, so only these three leaves subscribe to it. Add next to `SettingsPopover`:

```tsx
function useLiveContextUsage(runtimeHub: ChatRuntimeHub, sessionId: string, shell: ChatShellRuntime | null, busy: boolean) {
  const streamedCharsSinceBase = useChatRuntimeSelector(runtimeHub, (store) => selectStreamedCharsSinceBase(store, sessionId));
  return resolveLiveContextUsage({ contextUsage: shell?.contextUsage ?? null, liveTokenBase: shell?.liveTokenBase ?? null, streamedCharsSinceBase, busy });
}

type LiveContextProps = { runtimeHub: ChatRuntimeHub; sessionId: string; shell: ChatShellRuntime | null; busy: boolean };

function LiveContextBar({ runtimeHub, sessionId, shell, busy }: LiveContextProps) {
  const usage = useLiveContextUsage(runtimeHub, sessionId, shell, busy);
  if (!usage) return null;
  return (
    <div className={getContextBarFillTone(usage.ratio) === 'warn' ? 'ctx warn' : 'ctx'} title={`context ${formatNumber(usage.usedTokens)} / ${formatNumber(usage.contextWindowTokens)}`}>
      <i style={{ width: `${usage.ratio * 100}%` }} />
    </div>
  );
}

function LiveContextLabel({ runtimeHub, sessionId, shell, busy }: LiveContextProps) {
  const usage = useLiveContextUsage(runtimeHub, sessionId, shell, busy);
  return usage ? <span className="ctx-label">{formatLiveContextTokens(usage, formatCompactTokenCount)} / {formatCompactTokenCount(usage.contextWindowTokens)}</span> : null;
}

function LiveChatStatsBar({ lastTurn, sessionStats, ...context }: LiveContextProps & { lastTurn: LastTurnTelemetry; sessionStats: ChatSessionStats }) {
  const usage = useLiveContextUsage(context.runtimeHub, context.sessionId, context.shell, context.busy);
  return <ChatStatsBar lastTurn={lastTurn} sessionStats={sessionStats} liveContextUsage={usage} streaming={context.busy} />;
}
```

In the composer, replace the `{liveContextUsage ? (<div className=... ctx ...>) : null}` block with `<LiveContextBar runtimeHub={runtimeHub} sessionId={selectedSessionId} shell={shell} busy={selectedSessionBusy} />`, the `{liveContextUsage ? (<span className="ctx-label">...) : null}` block with `<LiveContextLabel ... />` (same props), and `<ChatStatsBar ... />` with `<LiveChatStatsBar runtimeHub={runtimeHub} sessionId={selectedSessionId} shell={shell} busy={selectedSessionBusy} lastTurn={lastTurnTelemetry} sessionStats={sessionPromptCacheStats} />`. Delete `liveContextUsage`, `usedRatio`, `contextTone` from the shell. (If `resolveLiveContextUsage`'s result has no `ratio` field, compute `usedRatio` exactly as the deleted shell code did, from the same result.)

Imports to add in `ChatTab.tsx`: `ChatRuntimeHub` (type), `useChatRuntimeSelector`, the selectors from `../lib/chat-runtime-selectors` (`selectRuntime`, `selectShellRuntime`, `sameShellRuntime`, `selectLiveMessages`, `selectLiveOperationId`, `selectCompactedEarlierHistory`, `selectActionableApproval`, `selectActionableQuestion`, `selectQuestionId`, `selectStreamedCharsSinceBase`, type `ChatShellRuntime`), `refoldsEarlierRows`, `useFollowWhilePinned`, type `ChatSessionRuntimeStore`. Remove imports that become unused (lint fails on them).

- [ ] **Step 8: Migrate `chat-tab.test.tsx`.** Apply these rules to all ≈150 sites:
  - In `buildProps`, replace `selectedRuntime: defaultStore.get(selectedSessionId), sessionRuntimes: defaultStore.getAll(),` with `runtimeHub: new ChatRuntimeHub(defaultStore),`.
  - An override `{ selectedRuntime: store.get(id), sessionRuntimes: store.getAll() }` (or either alone) becomes `{ runtimeHub: new ChatRuntimeHub(store) }`.
  - A test that re-renders ChatTab with a newer store to simulate streaming (e.g. `streaming follows only while the user is pinned to the bottom`) creates one hub up front and calls `await act(async () => hub.update(() => nextStore))` (or `hub.apply(transition)`) instead of `rerender` with new runtime props.
  - Do not weaken any assertion. If a test fails, the migration or the implementation is wrong. Fix the code, not the expectation.

- [ ] **Step 9: Compile and run.** `npm run build:test && node ./dist/test-runner/run-tests.js chat-tab useChatSessions app-shell`. Expected: all PASS, including the new isolation test (`shellRenders === 0`).

---

### Task 10: Projection appends without a whole-message parse

**Files:**
- Modify: `dashboard/src/lib/chat-operation-projection.ts` (`case 'append_text':` in `stageRecord`)
- Test: `dashboard/tests/chat-operation-projection.test.ts`

- [ ] **Step 1: Write the failing test** (append to `dashboard/tests/chat-operation-projection.test.ts`; it uses the file's existing `capture`, `feed`, `stateOf`, `nextTransferId` helpers and imports)

```ts
/** A committed view holding `row`, then one update transfer appending `text` to it with `metadata`. */
function appendOnto(row: ReturnType<typeof ChatTranscriptMessageSchema.parse>, text: string, metadata: ReturnType<typeof ChatTextRowMetadataSchema.parse>) {
  const before = capture(4, [row]);
  const projection = new ChatOperationProjection('s1');
  feed(projection, chatSnapshotFrames(before));
  const cursor = { operationId, sequence: 5, historyRevision: 0 };
  const records: ChatProjectionRecord[] = [
    { kind: 'begin', mode: 'update', sessionId: 's1', operationId, after: before.cursor, cursor, state: stateOf(before) },
    { kind: 'append_text', messageId: row.id, offset: row.content.length, text, metadata },
    { kind: 'commit', cursor, counts: { messages: 1, tools: 0, tokenTurns: 0, warnings: 0, issues: 0 } },
  ];
  return () => feed(projection, [...encodeChatProjectionRecords(records, nextTransferId())]);
}

test('an append that re-kinds a thinking row into narration keeps it an assistant text row', () => {
  const thinking = ChatTranscriptMessageSchema.parse({ ...message('think', 'a'), kind: 'assistant_thinking' });
  const metadata = ChatTextRowMetadataSchema.strip().parse({ ...message('think', 'a', 'assistant_narration') });
  const delivery = appendOnto(thinking, 'b', metadata)();
  assert.equal(delivery?.kind, 'view');
  if (delivery?.kind !== 'view') return;
  const row = delivery.snapshot.messages[0];
  assert.deepEqual([row?.id, row?.role, row?.kind, row?.content], ['think', 'assistant', 'assistant_narration', 'ab']);
});

test('an append that re-kinds a user-role row into narration is rejected', () => {
  const userRow = ChatTranscriptMessageSchema.parse({ ...message('u', 'a'), role: 'user' });
  const metadata = ChatTextRowMetadataSchema.strip().parse({ ...message('u', 'a', 'assistant_narration') });
  assert.throws(appendOnto(userRow, 'b', metadata), /re-kinds a non-assistant row/u);
});
```

- [ ] **Step 2: Run to verify failure.** `npm run build:test && node ./dist/test-runner/run-tests.js chat-operation-projection`. Expected: the second test FAILS (today's zod parse throws a zod error, not `re-kinds a non-assistant row`).

- [ ] **Step 3: Implement.** Replace the `append_text` case body and add the helper:

```ts
      case 'append_text': {
        const index = staged.messages.findIndex(message => message.id === record.messageId);
        const existing = staged.messages[index];
        if (!existing) fail('append to an unknown message');
        if (record.offset !== existing.content.length) fail('append offset mismatch');
        staged.messages[index] = appendTextRow(existing, record.text, record.metadata);
        return;
      }
```

```ts
/** The record was validated at the stream boundary, so the merge is typed instead of re-parsing the whole row per token. */
function appendTextRow(existing: ChatTranscriptMessage, text: string, metadata: ChatTextRowMetadata): ChatTranscriptMessage {
  if (existing.kind !== 'assistant_answer' && existing.kind !== 'assistant_thinking'
    && existing.kind !== 'assistant_narration' && existing.kind !== 'assistant_progress') fail('append to a non-text row');
  const content = existing.content + text;
  if (metadata.kind === 'assistant_narration' || metadata.kind === 'assistant_progress') {
    if (existing.role !== 'assistant') fail('append re-kinds a non-assistant row');
    return { ...existing, ...metadata, role: 'assistant', content };
  }
  return { ...existing, ...metadata, content };
}
```

Import `type ChatTextRowMetadata` from `@siftkit/contracts`; drop `ChatTranscriptMessageSchema` / `ChatTextRowKindSchema` imports if now unused. If `tsc` rejects a return (the discriminated union does not accept the spread), do not cast. Instead return the explicit per-kind object (`{ ...existing, ...metadata, kind: metadata.kind, role: 'assistant', content }` for the stream-text kinds, `{ ...existing, ...metadata, kind: metadata.kind, content }` otherwise), which narrows `kind` to one union member.

- [ ] **Step 4: Run to verify pass.** Same command. Expected: all PASS.

---

### Task 11: Full verification

- [ ] **Step 1:** `npm run build:test && node ./dist/test-runner/run-tests.js --dashboard`. Expected: `ℹ fail 0`.
- [ ] **Step 2:** `npm run typecheck`. Expected: exit 0 (includes lint).
- [ ] **Step 3: Scope check.** `git diff --stat` touches only the files in the File Structure table. `grep -rn "selectedRuntime\|sessionRuntimes\|setRuntimeStore\|runtimeStoreRef" dashboard/src dashboard/tests` returns nothing (complete replacement, no leftovers).
- [ ] **Step 4: Manual check (report, don't gate).** Build the dashboard (`cd dashboard && npm run build`), open the chat tab on a long session while a model streams, and record a Chrome Performance profile for ~10 s. Expected: per-token commits contain `LiveTranscript` subtrees only, and `App`/`ChatTab` appear only on non-token events (submit, terminal, queue changes). Report the script time per second next to the baseline in this plan's Background section.
