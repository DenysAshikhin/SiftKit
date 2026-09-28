# Chat Runtime External Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A streamed token re-renders only the live transcript and the live context meter, never `App`, `useChatController`, the ChatTab shell, or its persisted history. A pinned transcript stays at the bottom through every layout change, and the transcript never scrolls sideways.

**Architecture:** The immutable `ChatSessionRuntimeStore` moves out of React state into a subscribable `ChatRuntimeHub`. Components read slices through `useChatRuntimeSelector`, which is built on `useSyncExternalStore` and cached per store identity plus an equality check, so a slice re-renders only when its value really changes. The snapshot reducer shares unchanged values so that slow slices stay identical across token frames. ChatTab splits into a shell (slow slices), a memoized `PersistedTranscript`, a memoized `LiveTranscript` (per-token), and small live context meter components. Scroll following moves from a per-token message signature to a `ResizeObserver` on the transcript. Only an upward scroll unpins it.

**Tech Stack:** React 19 (`useSyncExternalStore`, callback-ref cleanup), TypeScript, zod, node:test + jsdom + @testing-library/react, esbuild test bundles.

**Repo rules that apply to every task (from the user's CLAUDE.md):**
- TypeScript only, inferred end to end.
- No `any`, no explicit `unknown` (lint-enforced), no `as` casts, no `!`, no namespace imports.
- TDD for every behaviour change.
- Complete replacements only. No shims, compatibility props or parallel paths. For example, do not keep `selectedRuntime` alongside `runtimeHub`, or `buildLiveMessageScrollSignature` alongside the observer.
- Comments are 1-2 lines.
- **Do not commit.** The user commits.
- No worktrees.

**Commands:**
- Build the test bundles. This is required after any change, before running tests: `npm run build:test`
- Run named test files: `node ./dist/test-runner/run-tests.js <name> [<name>...]`. The name is the test file's basename without extension, e.g. `chat-tab`.
- Full dashboard suite: `node ./dist/test-runner/run-tests.js --dashboard`
- Typecheck and lint. Lint runs at the end of typecheck: `npm run typecheck`
- Dashboard dev server, for the manual checks: `cd dashboard && npm run dev`, then open `http://127.0.0.1:6876/?tab=chat`.

**Background / measured baseline (2026-09-28 session):**
- Every server stream frame produces a `snapshot` transition. It is applied with `setRuntimeStore` at the top of `useChatSessions`, so each token re-renders `App`, every controller hook, and the whole `ChatTab`.
- Markdown re-parsing is already memoized in `dashboard/src/components/MarkdownContent.tsx` (`MarkdownContent`, `MarkdownBlocks`). The per-token cost that remains has three parts:
  - React reconciliation of the full tree: about 400 ms of script per 10 s at 60 tokens/s on the largest local session.
  - An FNV hash of every live message's whole content, from `buildLiveMessageScrollSignature`.
  - A whole-message zod re-parse per `append_text` record in `ChatOperationProjection`.

**Two UI bugs are fixed in the same refactor (root causes verified in code):**
- *Stick-to-bottom is inconsistent.* `useChatScroll` follows only when the live message signature changes, in an effect right after the frame's commit. There are two failures:
  - `useSmoothedText` then reveals the text over later animation frames, so the bubble keeps growing with nothing scrolling. So does `snap()` at stream end, images that load, `<details>` toggles, and the composer growing.
  - Worse, `onChatLogScroll` treats *any* scroll event that is not within 4 px of the bottom as the user leaving. When content grows between the programmatic `scrollTop = scrollHeight` and its scroll event, the log unpins permanently, and the user has to scroll down by hand.
- *Approving a long command adds a horizontal scrollbar that persists.* `.msgs` is `display: grid` with the implicit `auto` column, and an `auto` track is at least as wide as its widest item's min-content. After a decision, the transcript contains a `RepoAgentApprovalRow` whose `.cmd-inline` is `white-space: nowrap`. Its `max-width: 40%` is ignored for intrinsic sizing, so the column grows to the full command width and `.msgs` (with `overflow-y: auto`, which implies `overflow-x: auto`) scrolls sideways for as long as that row exists.
- The same mechanism applies to any other unbreakable content:
  - long paths, URLs or inline code in answers
  - GFM tables
  - a long `reviewPayload`
  - many question choices in a non-wrapping `.approval-actions` row
  - long error text in `.err-banner`
- A bounded column alone is not enough: a descendant that is still too wide overflows its card and scrolls `.msgs` anyway. Two such sources remain after the rules above:
  - a long question choice: `.send` is `flex: none`, so the button stays one line as wide as its whole label
  - a wide markdown image: `.markdown-body img` had no `max-width`
- *Measured audit (headless Chrome, real dashboard CSS, 900 px log, `C:\tmp\chat-overflow-probe`):* 12 transcript row types were each filled with hostile content: 400-char words, long commands and paths, a 40-column table, a 3000 px image, and sentence-long choices. The 12 types are approval row, repo-agent approval card, question card, orchestrator panel with its approval card, markdown answer, markdown image, user message with image, tool call details, thinking/internal logic, system context, compaction, and banners. Before the fix, 11 of 12 scrolled sideways (all except system context). After Task 8, 0 of 12 scroll, and no descendant escapes its bubble or card.

**Test helpers already available:**
- `dashboard/tests/render-tracker.ts` exports `countRenders(elementType, action)`. It counts how many times components of a given element type rendered while `action` ran, using React's DevTools commit hook.
- `dashboard/tests/react-test-environment.ts` imports the render tracker first, so any test that imports `./react-test-environment.js` first can use `countRenders`.

**Known accepted behaviour change:** When a run finishes, its rows move from `LiveTranscript` into `PersistedTranscript`. These are different parents, so those bubbles remount. An "Internal Logic" disclosure expanded on the live turn collapses when the run completes. Today it survives because both halves share one list.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `dashboard/src/lib/chat-session-runtime-store.ts` | Modify | Snapshot reducer shares unchanged `activity` / `warnings` values. |
| `dashboard/src/lib/chat-runtime-hub.ts` | Create | `ChatRuntimeHub`: the one mutable holder of the store, plus subscribe/notify. |
| `dashboard/src/hooks/useChatRuntimeSelector.ts` | Create | `useChatRuntimeSelector(hub, select, isEqual)`: cached `useSyncExternalStore` slice. |
| `dashboard/src/lib/chat-runtime-selectors.ts` | Create | Named selectors + equality for the ChatTab shell and the live transcript. |
| `dashboard/src/lib/chat-session-state.ts` | Modify | `isSessionBusy` / `hasActiveRepoAgentRun` accept the fields they read (`Pick`). |
| `dashboard/src/lib/chat-live-token-display.ts` | Modify | `buildLiveTokenDisplays` accepts the fields it reads (`Pick`). |
| `dashboard/src/lib/compaction-segments.ts` | Modify | `refoldsEarlierRows(live)`: whether live rows can re-fold persisted rows. |
| `dashboard/src/hooks/useChatSessions.ts` | Modify | Owns a `ChatRuntimeHub` instead of `useState` for the store; returns `runtimeHub`. |
| `dashboard/src/hooks/useChatController.ts` | Modify | Passes `runtimeHub`; callbacks read `runtimeHub.getStore()` when called. |
| `dashboard/src/hooks/useChatScroll.ts` | Modify | `ResizeObserver` follow via a `chatContentRef` callback ref; only an upward scroll unpins; no signature/ids inputs. |
| `dashboard/src/lib/chatMessages.ts` | Modify | Delete `buildLiveMessageScrollSignature` and `hashFnv1a32` (their only consumer). |
| `dashboard/src/styles/chat.css` | Modify | `.msgs` scrolls, `.msgs-content` is the `minmax(0, 1fr)` grid, and wrapping/containment rules. |
| `dashboard/src/tabs/ChatTab.tsx` | Modify | Prop `runtimeHub` replaces `selectedRuntime` / `sessionRuntimes`. The shell reads slow slices; `PersistedTranscript`, `LiveTranscript`, `LiveContextBar`, `LiveContextLabel`, `LiveChatStatsBar`. |
| `dashboard/src/lib/chat-operation-projection.ts` | Modify | `append_text` merges typed, without a whole-message zod parse. |
| `dashboard/tests/react-test-environment.ts` | Modify | Installs a controllable `ResizeObserver`; exports `notifyResize()`. |
| Tests | Create/Modify | `tests/chat-runtime-hub.test.ts`, `tests/hooks/useChatRuntimeSelector.test.tsx`, `tests/chat-runtime-selectors.test.ts`, `tests/lib/compaction-segments.test.ts`, `tests/chat-session-runtime-store.test.ts`, `tests/hooks/useChatSessions.test.tsx`, `tests/chat-tab.test.tsx`, `tests/chat-layout-css.test.ts`, `tests/lib/chatMessages.test.ts`, `tests/chat-operation-projection.test.ts` (all under `dashboard/`). |

---

### Task 1: Snapshot reducer shares unchanged values

A snapshot transition rewrites two values on every frame:
- `activity` is a new object every frame.
- `warnings` is copied by the projection on every transfer.

Both must keep their previous identity when they are equal. Otherwise every shell slice changes per token.

**Files:**
- Modify: `dashboard/src/lib/chat-session-runtime-store.ts`, the `case 'snapshot':` branch of `applyTransition` (lines 141-159).
- Test: `dashboard/tests/chat-session-runtime-store.test.ts`

- [x] **Step 1: Write the failing test.** Append it to `dashboard/tests/chat-session-runtime-store.test.ts`. Import `chatSnapshot` from `./chat-snapshot-fixture.js` and `createLiveMessage` from `../src/lib/chat-live-messages` if the file does not already import them.

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

- [x] **Step 2: Run to verify failure.** `npm run build:test && node ./dist/test-runner/run-tests.js chat-session-runtime-store`. Expected: the first new test FAILS on the `activity` identity assertion. The second passes; it guards the replacement path.

- [x] **Step 3: Implement.** In `chat-session-runtime-store.ts`, add these helpers above `applyTransition`:

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

This object is identical to today's except for `activity` and `warnings`. `pendingApproval` and `liveTokenBase` already keep their identity across update transfers: `ChatOperationProjection.stage` carries the base `approval` and `tokenTurns` objects forward, and the server re-sends a token turn only when it changed.

- [x] **Step 4: Run to verify pass.** Same command. Expected: all tests in the file PASS.

---

### Task 2: `ChatRuntimeHub`

**Files:**
- Create: `dashboard/src/lib/chat-runtime-hub.ts`
- Test: `dashboard/tests/chat-runtime-hub.test.ts`

- [x] **Step 1: Write the failing test**

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

- [x] **Step 2: Run to verify failure.** `npm run build:test`. Expected: the build FAILS because module `chat-runtime-hub` is not found. That is the red state.

- [x] **Step 3: Implement** `dashboard/src/lib/chat-runtime-hub.ts`:

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

- [x] **Step 4: Run to verify pass.** `npm run build:test && node ./dist/test-runner/run-tests.js chat-runtime-hub`. Expected: 3 PASS.

---

### Task 3: `useChatRuntimeSelector`

**Files:**
- Create: `dashboard/src/hooks/useChatRuntimeSelector.ts`
- Test: `dashboard/tests/hooks/useChatRuntimeSelector.test.tsx`

- [x] **Step 1: Write the failing test**

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

- [x] **Step 2: Run to verify failure.** `npm run build:test`. Expected: the build FAILS (module not found).

- [x] **Step 3: Implement** `dashboard/src/hooks/useChatRuntimeSelector.ts`:

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

- [x] **Step 4: Run to verify pass.** `npm run build:test && node ./dist/test-runner/run-tests.js useChatRuntimeSelector`. Expected: 3 PASS.

---

### Task 4: Named runtime selectors

**Files:**
- Create: `dashboard/src/lib/chat-runtime-selectors.ts`
- Modify: `dashboard/src/lib/chat-session-state.ts` (parameter types of `isSessionBusy`, `hasActiveRepoAgentRun`)
- Modify: `dashboard/src/lib/chat-live-token-display.ts` (parameter type of `buildLiveTokenDisplays`)
- Test: `dashboard/tests/chat-runtime-selectors.test.ts`

- [x] **Step 1: Write the failing test**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatSessionRuntimeStore } from '../src/lib/chat-session-runtime-store';
import { createLiveMessage } from '../src/lib/chat-live-messages';
import { chatSnapshot } from './chat-snapshot-fixture.js';
import {
  sameLiveTranscript, sameShellRuntime, selectLiveMessages, selectLiveOperationId, selectLiveTranscript, selectShellRuntime,
  selectStreamedCharsSinceBase,
} from '../src/lib/chat-runtime-selectors';

const OPERATION_ID = '4f9c1f9a-0000-4000-8000-0000000000d1';

function frame(text: string, sequence: number) {
  return chatSnapshot({ sessionId: 's1', operationId: OPERATION_ID, cursor: { operationId: OPERATION_ID, sequence },
    messages: [createLiveMessage('a', 'assistant_answer', 'assistant', text)] });
}

function streamed(text: string, sequence: number): ChatSessionRuntimeStore {
  return new ChatSessionRuntimeStore().ensureSession('s1', '').apply({ kind: 'snapshot', sessionId: 's1', snapshot: frame(text, sequence) });
}

test('the shell slice is equal across token frames and differs on a slow-field change', () => {
  const first = streamed('he', 1);
  const second = first.apply({ kind: 'snapshot', sessionId: 's1', snapshot: frame('hello', 2) });
  assert.equal(sameShellRuntime(selectShellRuntime(first, 's1'), selectShellRuntime(second, 's1')), true);
  const drafted = second.apply({ kind: 'draft', sessionId: 's1', draft: 'x' });
  assert.equal(sameShellRuntime(selectShellRuntime(second, 's1'), selectShellRuntime(drafted, 's1')), false);
});

test('the live transcript slice ignores composer edits and follows stream frames', () => {
  const first = streamed('he', 1);
  const drafted = first.apply({ kind: 'draft', sessionId: 's1', draft: 'x' });
  assert.equal(sameLiveTranscript(selectLiveTranscript(first, 's1'), selectLiveTranscript(drafted, 's1')), true);
  const next = first.apply({ kind: 'snapshot', sessionId: 's1', snapshot: frame('hello', 2) });
  assert.equal(sameLiveTranscript(selectLiveTranscript(first, 's1'), selectLiveTranscript(next, 's1')), false);
});

test('selectors read an unknown session as empty values', () => {
  const store = new ChatSessionRuntimeStore();
  assert.equal(selectShellRuntime(store, 'ghost'), null);
  assert.equal(selectLiveTranscript(store, 'ghost'), null);
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

- [x] **Step 2: Run to verify failure.** `npm run build:test`. Expected: the build FAILS (module not found).

- [x] **Step 3: Implement** `dashboard/src/lib/chat-runtime-selectors.ts`:

```ts
import type { ChatOperationSnapshot } from '@siftkit/contracts';
import type { ChatMessage } from '../types';
import type { ChatSessionRuntime, ChatSessionRuntimeStore } from './chat-session-runtime-store';

/** Runtime fields a stream frame rewrites on every token; only live components read them. */
export type ChatShellRuntime = Omit<ChatSessionRuntime, 'journalSnapshot' | 'liveMessages' | 'tokenTurns' | 'streamedCharsSinceBase'>;

/** What the live transcript renders; a composer edit leaves all four identical. */
export type LiveTranscriptSlice = Pick<ChatSessionRuntime, 'journalSnapshot' | 'liveMessages' | 'tokenTurns' | 'awaitingResponse'>;

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

export function selectLiveTranscript(store: ChatSessionRuntimeStore, sessionId: string): LiveTranscriptSlice | null {
  const runtime = selectRuntime(store, sessionId);
  if (!runtime) return null;
  return { journalSnapshot: runtime.journalSnapshot, liveMessages: runtime.liveMessages, tokenTurns: runtime.tokenTurns,
    awaitingResponse: runtime.awaitingResponse };
}

export function sameLiveTranscript(left: LiveTranscriptSlice | null, right: LiveTranscriptSlice | null): boolean {
  if (left === null || right === null) return left === right;
  return left.journalSnapshot === right.journalSnapshot && left.liveMessages === right.liveMessages
    && left.tokenTurns === right.tokenTurns && left.awaitingResponse === right.awaitingResponse;
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

The unused destructured names in `selectShellRuntime` are allowed, because the lint config sets `ignoreRestSiblings: true`.

In `dashboard/src/lib/chat-session-state.ts`, narrow the two parameter types. The bodies stay unchanged:

```ts
export function isSessionBusy(runtime: Pick<ChatSessionRuntime, 'activity' | 'pendingApproval' | 'submissionPhase'> | null): boolean {
export function hasActiveRepoAgentRun(runtime: Pick<ChatSessionRuntime, 'activity'> | null): boolean {
```

In `dashboard/src/lib/chat-live-token-display.ts`, narrow the parameter. The body reads only these three fields:

```ts
export function buildLiveTokenDisplays(runtime: Pick<ChatSessionRuntime, 'journalSnapshot' | 'liveMessages' | 'tokenTurns'>): ReadonlyMap<string, TokenDisplay> {
```

- [x] **Step 4: Run to verify pass.** `npm run build:test && node ./dist/test-runner/run-tests.js chat-runtime-selectors chat-session-state chat-live-token-display`. Expected: all PASS. Then run `npm run typecheck`. Expected: exit 0, which confirms that the completeness check and the `Pick` narrowings compile.

---

### Task 5: `useChatSessions` owns a hub

This is a mechanical replacement: the hook stops holding the store in React state.

**Files:**
- Modify: `dashboard/src/hooks/useChatSessions.ts`
- Test: `dashboard/tests/hooks/useChatSessions.test.tsx`

- [x] **Step 1: Write the failing tests.** Append them to `dashboard/tests/hooks/useChatSessions.test.tsx`. Add the imports `import { useChatRuntimeSelector } from '../../src/hooks/useChatRuntimeSelector';` and `import { selectLiveMessages } from '../../src/lib/chat-runtime-selectors';`.

```tsx
test('runtime transitions never re-render the hook that owns the hub', async () => {
  const fixture = new ChatFetchFixture({ session: SESSION, detailResponse: { session: SESSION, contextUsage: CONTEXT_USAGE },
    streamResponse: { session: SESSION, contextUsage: CONTEXT_USAGE } });
  try {
    let renders = 0;
    const hook = renderHook(() => {
      renders += 1;
      return useChatSessions({ initialSelectedSessionId: 's1', refreshToken: 0,
        buildCreateSessionRequest: () => null, confirmDeleteSession: () => true, enqueueToast: () => {} });
    });
    await waitFor(() => {
      assert.notEqual(hook.result.current.selectedSession, null);
      assert.equal(hook.result.current.selectedSessionLoading, false);
    });
    const before = renders;
    await act(async () => {
      hook.result.current.runtimeHub.apply({ kind: 'draft', sessionId: 's1', draft: 'typing' });
      hook.result.current.runtimeHub.apply({ kind: 'plan-inputs', sessionId: 's1', planRepoRootInput: 'C:/x', planMaxTurnsInput: '5' });
    });
    assert.equal(renders, before);
    assert.equal(hook.result.current.runtimeHub.getStore().get('s1').draft, 'typing');
    hook.unmount();
  } finally {
    fixture.restore();
  }
});

test('a finished run hands its rows from the live view to the stored transcript without an empty frame', async () => {
  const answer = createLiveMessage('answer', 'assistant_answer', 'assistant', 'final answer');
  const settled: ChatSession = { ...SESSION,
    messages: [chatMessage({ id: 'answer', role: 'assistant', content: 'final answer', sourceRunId: OPERATION_ID })] };
  const fixture = new ChatFetchFixture({
    session: SESSION,
    detailResponse: { session: SESSION, contextUsage: CONTEXT_USAGE },
    streamResponse: { session: settled, contextUsage: CONTEXT_USAGE },
    operationStream: snapshotBody({ terminalCause: 'completed', messages: [answer] }) + terminalBody(),
    settleAfterAttach: true,
  });
  const frames: string[] = [];
  try {
    const hook = renderHook(() => {
      const chat = useChatSessions({ initialSelectedSessionId: 's1', refreshToken: 0,
        buildCreateSessionRequest: () => null, confirmDeleteSession: () => true, enqueueToast: () => {} });
      const live = useChatRuntimeSelector(chat.runtimeHub, (store) => selectLiveMessages(store, 's1'));
      frames.push(`${chat.selectedSession?.messages.length ?? 0}/${live.length}`);
      return chat;
    });
    await waitFor(() => assert.equal(hook.result.current.selectedSession?.messages.length, 1));
    await waitFor(() => assert.equal(hook.result.current.runtimeHub.getStore().get('s1').liveMessages.length, 0));
    const firstLive = frames.indexOf('0/1');
    assert.notEqual(firstLive, -1, frames.join(' '));
    assert.equal(frames.slice(firstLive).includes('0/0'), false, frames.join(' '));
    hook.unmount();
  } finally {
    fixture.restore();
  }
});
```

In `ChatFetchFixture`, add the option and honour it in the `/operation/stream` branch, directly after `frames` is known to be defined:

```ts
    /** Serves the settled session detail once the attached run's stream has been read. */
    settleAfterAttach?: boolean;
```
```ts
        if (this.options.settleAfterAttach) this.settled = true;
```

- [x] **Step 2: Run to verify failure.** `npm run build:test`. Expected: the build FAILS because `runtimeHub` does not exist on the hook result.

- [x] **Step 3: Implement in `useChatSessions.ts`**

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
2. Replace every `setRuntimeStore(` call with `runtimeHub.update(`. The updater functions stay byte-for-byte the same. Where the updater is a single `.apply(x)`, you may write `runtimeHub.apply(x)` instead. Updaters now run synchronously, which is safe: none of them has side effects, and none returns a value through a closure.
3. Replace every read of `runtimeStoreRef.current` and every read of the render-time `runtimeStore` variable with `runtimeHub.getStore()`. The reads are in:
   - `recordSessionError`
   - `readRuntimeInputs`
   - `answerQuestion`
   - `shouldQueue`
   - `queueMessage`
   - `forceQueue`
   - `setRepoAgentApprovalMode`
   - `stopOperation`
   - the idle branch of the attach effect
4. In the returned object, replace `runtimeStore,` with `runtimeHub,`.
5. Imports:
   - Add `import { ChatRuntimeHub } from '../lib/chat-runtime-hub';`.
   - Change the store import to `import type { ChatSessionRuntimeTransition } from '../lib/chat-session-runtime-store';` if `ChatSessionRuntimeStore` is no longer referenced.
   - Keep `useLatest` only if it is still used. Lint fails on unused imports.

- [x] **Step 4: Migrate existing hook tests.** In `dashboard/tests/hooks/useChatSessions.test.tsx`, replace every `hook.result.current.runtimeStore.` with `hook.result.current.runtimeHub.getStore().`. There are 54 `runtimeStore` matches in the file. `waitFor` polls, so no re-render is needed.

- [x] **Step 5: Run.** `npm run build:test && node ./dist/test-runner/run-tests.js useChatSessions`. Expected: all PASS, including both new tests.

React 19 renders pending default-lane updates together with a `useSyncExternalStore` sync update (unified sync lane). That means the `storeSession` state update and the following `hub.apply(terminal)` commit in one frame, and the handoff test passes.

**If the handoff test FAILS with a `0/0` frame,** make the stored transcript commit before any hub transition that follows it. In `storeSession`, wrap the two React state updates:

```ts
  function storeSession(session: ChatSession): void {
    // Hub updates render in the sync lane; commit the transcript first so a live view never retires into nothing.
    flushSync(() => {
      setLoadedSessions((previous) => new Map(previous).set(session.id, session));
      setSessions((previous) => upsertSession(previous, session));
    });
    runtimeHub.update((previous) => previous.ensureSession(session.id, session.planRepoRoot));
  }
```

Add `import { flushSync } from 'react-dom';` for that fix. Then re-run and expect PASS.

---

### Task 6: `useChatController` passes the hub

**Files:**
- Modify: `dashboard/src/hooks/useChatController.ts`

This task compiles only together with Task 10 (ChatTab props). Make the edits now; Task 10 Step 10 verifies them.

- [x] **Step 1: Remove `selectedRuntime`.** Delete the whole `const selectedRuntime = chatSessionsHook.selectedSessionId ? (() => { ... })() : null;` block.

- [x] **Step 2: Read the runtime when called.** Add under the other derived values:

```ts
  const runtimeHub = chatSessionsHook.runtimeHub;
  /** Read at call time: the controller no longer re-renders per runtime change, so a captured runtime would be stale. */
  function readSelectedRuntime(): ChatSessionRuntime | null {
    return selectRuntime(runtimeHub.getStore(), chatSessionsHook.selectedSessionId);
  }
```

Then make these changes in `tabProps`:
- Replace `selectedRuntime,` and `sessionRuntimes: chatSessionsHook.runtimeStore.getAll(),` with `runtimeHub,`.
- `onChangePlanRepoRoot`: `const runtime = readSelectedRuntime(); if (!chatSessionsHook.selectedSessionId || !runtime) return; chatSessionsHook.setSessionPlanInputs(chatSessionsHook.selectedSessionId, value, runtime.planMaxTurnsInput);`
- `onChangePlanMaxTurns`: the same shape, passing `runtime.planRepoRootInput, value`.
- `onSavePlanRepoRoot`: `() => chatSessionsHook.savePlanRepoRoot(readSelectedRuntime()?.planRepoRootInput ?? '', selectedChatPreset?.id)`

Imports: `import { selectRuntime } from '../lib/chat-runtime-selectors';` and `import type { ChatSessionRuntime } from '../lib/chat-session-runtime-store';`.

---

### Task 7: Pinned scrolling follows every layout change

This task fixes the inconsistent stick-to-bottom bug. It works on today's ChatTab props; Task 10 moves the call onto the hub.

**Files:**
- Modify: `dashboard/src/hooks/useChatScroll.ts`
- Modify: `dashboard/src/tabs/ChatTab.tsx` (the `useChatScroll` call and the `.msgs` markup)
- Modify: `dashboard/src/styles/chat.css` (`.msgs` rule)
- Modify: `dashboard/src/lib/chatMessages.ts`, `dashboard/tests/lib/chatMessages.test.ts`
- Modify: `dashboard/tests/react-test-environment.ts`
- Test: `dashboard/tests/chat-tab.test.tsx`

- [x] **Step 1: Give tests a controllable `ResizeObserver`.** jsdom has none. In `dashboard/tests/react-test-environment.ts`, add the following above the `Object.assign(globalThis, ...)` call, and add `ResizeObserver: TestResizeObserver,` to that object:

```ts
const resizeListeners = new Set<() => void>();

/** jsdom has no layout; tests call notifyResize() where a browser would report a size change. */
class TestResizeObserver {
  private readonly notify: () => void;
  constructor(callback: ResizeObserverCallback) { this.notify = () => callback([], this); }
  observe(): void { resizeListeners.add(this.notify); }
  unobserve(): void {}
  disconnect(): void { resizeListeners.delete(this.notify); }
}

export function notifyResize(): void {
  for (const notify of resizeListeners) notify();
}
```

- [x] **Step 2: Write the failing tests.** In `dashboard/tests/chat-tab.test.tsx`, add `notifyResize` to the `./react-test-environment.js` import. Replace `configureChatScroll` with a version that leaves the log pinned at its bottom, as a freshly opened transcript is:

```ts
/** Sizes the log and leaves it resting at its bottom, where a freshly opened transcript is pinned. */
function configureChatScroll(element: HTMLElement): { setScrollHeight(value: number): void } {
  let scrollHeight = 1_000;
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => 200 });
  Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  element.scrollTop = 800;
  fireEvent.scroll(element);
  return { setScrollHeight: (value) => { scrollHeight = value; } };
}
```

Append:

```tsx
test('a pinned log follows growth that arrives without a new stream frame', async () => {
  const view = renderComponent(<ChatTab {...buildProps()} />);
  const chatLog = view.container.querySelector('.msgs');
  assert.ok(chatLog instanceof HTMLElement);
  const scroll = configureChatScroll(chatLog);
  scroll.setScrollHeight(1_300);
  await act(async () => notifyResize());
  assert.equal(chatLog.scrollTop, 1_300);
});

test('a scroll event caused by growth below the viewport keeps the log pinned', async () => {
  const view = renderComponent(<ChatTab {...buildProps()} />);
  const chatLog = view.container.querySelector('.msgs');
  assert.ok(chatLog instanceof HTMLElement);
  const scroll = configureChatScroll(chatLog);
  scroll.setScrollHeight(1_300);
  fireEvent.scroll(chatLog);
  assert.equal(screen.queryByRole('button', { name: 'Jump to bottom' }), null);
  await act(async () => notifyResize());
  assert.equal(chatLog.scrollTop, 1_300);
});

test('scrolling up unpins, and growth then leaves the reading position alone', async () => {
  const view = renderComponent(<ChatTab {...buildProps()} />);
  const chatLog = view.container.querySelector('.msgs');
  assert.ok(chatLog instanceof HTMLElement);
  const scroll = configureChatScroll(chatLog);
  chatLog.scrollTop = 300;
  fireEvent.scroll(chatLog);
  assert.ok(screen.getByRole('button', { name: 'Jump to bottom' }));
  scroll.setScrollHeight(1_300);
  await act(async () => notifyResize());
  assert.equal(chatLog.scrollTop, 300);
});
```

In the three existing scroll tests, a content change now reaches the log through a layout change, not through a re-render. The three tests are `streaming follows only while the user is pinned to the bottom`, `switching sessions resets pinned scrolling and hides the jump control`, and `each distinct repo-agent approval forces one scroll to the bottom`. For each `await act(async () => { view.rerender(...); });` that expects the log to follow, change it to `await act(async () => { view.rerender(...); notifyResize(); });`. Keep every assertion exactly as it is.

- [x] **Step 3: Run to verify failure.** `npm run build:test && node ./dist/test-runner/run-tests.js chat-tab`. Expected: `a pinned log follows growth…` FAILS (scrollTop stays 800), and `a scroll event caused by growth…` FAILS (the jump button appears). The third new test passes; it guards the unpin path.

- [x] **Step 4: Implement `useChatScroll.ts`.** Replace everything from `export type UseChatScrollResult` to the end of the file, keeping `ScrollTarget`, `ScrollableElement`, `BOTTOM_THRESHOLD_PX`, `isChatLogAtBottom`, `scrollChatLogToBottom`:

```ts
export type UseChatScrollResult = {
  chatLogRef: React.RefObject<HTMLDivElement | null>;
  /** Attach to the log's content wrapper: every size change of either re-follows a pinned log. */
  chatContentRef: React.RefCallback<HTMLDivElement>;
  onChatLogScroll(): void;
  jumpToBottom(): void;
  showJumpToBottom: boolean;
};
```
```ts
/** Records where following left the log, so the scroll event it causes never reads as the user moving up. */
function followBottom(element: HTMLDivElement | null, lastScrollTopRef: React.RefObject<number>): void {
  scrollChatLogToBottom(element);
  lastScrollTopRef.current = element?.scrollTop ?? 0;
}

export function useChatScroll(sessionId: string, pendingApprovalId: string | null): UseChatScrollResult {
  const chatLogRef = useRef<HTMLDivElement | null>(null);
  const pinnedToBottomRef = useRef(true);
  // Where the log was last left; only a move above it is the user leaving the bottom.
  const lastScrollTopRef = useRef(0);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  function pinToBottom(): void {
    followBottom(chatLogRef.current, lastScrollTopRef);
    pinnedToBottomRef.current = true;
    setShowJumpToBottom(false);
  }

  function onChatLogScroll(): void {
    const element = chatLogRef.current;
    if (!element) return;
    const movedUp = element.scrollTop < lastScrollTopRef.current;
    lastScrollTopRef.current = element.scrollTop;
    // Content growing under a pinned log fires scroll events too; those must not unpin it.
    if (isChatLogAtBottom(element)) {
      pinnedToBottomRef.current = true;
      setShowJumpToBottom(false);
    } else if (movedUp) {
      pinnedToBottomRef.current = false;
      setShowJumpToBottom(true);
    }
  }

  // A callback ref: the log mounts only once a session shows, and React 19 runs the returned cleanup on detach.
  const chatContentRef = useCallback((content: HTMLDivElement | null) => {
    const log = content?.parentElement;
    if (!content || !log) return undefined;
    const observer = new ResizeObserver(() => {
      if (pinnedToBottomRef.current) followBottom(chatLogRef.current, lastScrollTopRef);
    });
    observer.observe(content);
    observer.observe(log);
    return () => observer.disconnect();
  }, []);

  useEffect(() => { pinToBottom(); }, [sessionId]);

  useEffect(() => {
    if (pendingApprovalId !== null) pinToBottom();
  }, [pendingApprovalId]);

  return { chatLogRef, chatContentRef, onChatLogScroll, jumpToBottom: pinToBottom, showJumpToBottom };
}
```

Change the import line to `import React, { useCallback, useEffect, useRef, useState } from 'react';`. Observing both the content and the log covers two cases: text or images growing, and the log shrinking because the composer grew.

- [x] **Step 5: Wire ChatTab.**
  - Delete `visibleMessageIds`, `liveMessageScrollSignature` and the `buildLiveMessageScrollSignature` import.
  - The call becomes `const { chatLogRef, chatContentRef, onChatLogScroll, jumpToBottom, showJumpToBottom } = useChatScroll(selectedSessionId, selectedRuntime?.pendingApproval?.approvalId ?? selectedRuntime?.journalSnapshot?.question?.questionId ?? null);`.
  - Wrap every child of `.msgs` in one element. That covers the prompt context, the segments, the orchestrator panel, the approval and question cards, and the recent-activity section:

```tsx
              <div className="msgs" ref={chatLogRef} onScroll={onChatLogScroll} hidden={selectedSessionLoading}>
                <div className="msgs-content" ref={chatContentRef}>
                  {/* …the existing children, unchanged… */}
                </div>
              </div>
```

In `chat.css`, split the `.msgs` rule so that the log scrolls and its content lays out:

```css
.msgs { height: 100%; box-sizing: border-box; overflow-y: auto; padding: 14px 18px 52px; }
.msgs-content { display: grid; gap: 10px; align-content: start; }
```

- [x] **Step 6: Delete the signature.** In `dashboard/src/lib/chatMessages.ts`, delete `hashFnv1a32` and `buildLiveMessageScrollSignature`; `estimatePromptTokens` stays. In `dashboard/tests/lib/chatMessages.test.ts`, delete their five tests and their imports. `BASE_MESSAGE` and the `ChatMessage` type import go too if nothing else uses them.

- [x] **Step 7: Run to verify pass.** `npm run build:test && node ./dist/test-runner/run-tests.js chat-tab chatMessages useChatScroll`. Expected: all PASS.

---

### Task 8: The transcript never scrolls sideways

This task fixes the long-command approval bug and every other source of horizontal overflow in the chat.

**Files:**
- Modify: `dashboard/src/styles/chat.css`
- Test: `dashboard/tests/chat-layout-css.test.ts`

jsdom has no layout engine, so this task is covered in two ways. A source contract test guards the four rules, following the same precedent as `tests/agent-loop-boundary.test.ts`, which reads source text. Step 5 then measures the layout in a real browser.

- [x] **Step 1: Reproduce in the browser (before the fix).** Start the dev server, open a chat session, and run this in the DevTools console:

```js
(() => {
  const content = document.querySelector('.msgs-content'); const log = document.querySelector('.msgs');
  const probe = document.createElement('div'); probe.innerHTML = `
    <div class="approval-row ok"><span class="verdict">✓ Approved</span><span class="cmd-inline">${'npm run build -- --filter=' + 'x'.repeat(600)}</span></div>
    <article class="msg ai"><div class="markdown-body"><p>${'y'.repeat(600)}</p>
      <table><tr>${'<td>wide cell</td>'.repeat(60)}</tr></table></div></article>
    <section class="approval-card"><div class="approval-actions">${'<button class="send">A long answer choice</button>'.repeat(12)}</div></section>`;
  content.append(probe); const fits = log.scrollWidth <= log.clientWidth; probe.remove(); return fits;
})()
```

Expected: `false`. This reproduces the sideways scroll.

- [x] **Step 2: Write the failing test** `dashboard/tests/chat-layout-css.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const CHAT_CSS = fs.readFileSync(path.join(process.cwd(), 'dashboard', 'src', 'styles', 'chat.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//gu, '');

/** The declarations of the one rule whose selector is exactly `selector`, whitespace-normalized. */
function declarationsOf(selector: string): string[] {
  const rules = [...CHAT_CSS.matchAll(/([^{}]+)\{([^}]*)\}/gu)].filter((match) => match[1]?.trim() === selector);
  assert.equal(rules.length, 1, `expected exactly one "${selector}" rule`);
  return (rules[0]?.[2] ?? '').split(';').map((declaration) => declaration.trim().replace(/\s+/gu, ' ')).filter(Boolean);
}

test('the transcript column never grows past the log, whatever a row cannot wrap', () => {
  assert.ok(declarationsOf('.msgs-content').includes('grid-template-columns: minmax(0, 1fr)'));
});

test('unbreakable text wraps anywhere in the chat instead of widening it', () => {
  assert.ok(declarationsOf('.chat-main').includes('overflow-wrap: anywhere'));
});

test('a wide markdown table scrolls inside its bubble', () => {
  const table = declarationsOf('.markdown-body table');
  assert.ok(table.includes('display: block'));
  assert.ok(table.includes('overflow-x: auto'));
});

test('approval and question actions wrap onto new lines', () => {
  assert.ok(declarationsOf('.approval-actions').includes('flex-wrap: wrap'));
});

test('a long question choice wraps inside its button instead of widening the card', () => {
  assert.ok(declarationsOf('.approval-actions > *').includes('max-width: 100%'));
});

test('a wide markdown image scales down to its bubble', () => {
  const image = declarationsOf('.markdown-body img');
  assert.ok(image.includes('max-width: 100%'));
  assert.ok(image.includes('height: auto'));
});
```

- [x] **Step 3: Run to verify failure.** `npm run build:test && node ./dist/test-runner/run-tests.js chat-layout-css`. Expected: 6 FAIL.

- [x] **Step 4: Implement** in `dashboard/src/styles/chat.css`:

```css
.chat-main { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; overflow-wrap: anywhere; }
```
```css
/* minmax(0, …): an auto column grows to its widest unwrappable row (a nowrap approved command) and scrolls sideways. */
.msgs-content { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; align-content: start; }
```
Add after `.markdown-body :last-child`:
```css
.markdown-body table { display: block; max-width: 100%; overflow-x: auto; }
```
```css
.markdown-body img { max-width: 100%; height: auto; }
```
```css
.approval-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; }
/* `.send` is flex: none, so a long question choice would stay one line wider than the card. */
.approval-actions > * { max-width: 100%; }
```
The queue list now inherits the wrap from `.chat-main`, so drop its own copy:
```css
.chat-pending-queue li { padding: 4px 0; }
```

Once the column is bounded, `.approval-row .cmd-inline`'s `max-width: 40%` resolves, so the approved command truncates with its existing ellipsis. `.msg`'s `max-width: 72%` clamps each bubble, and the table and the wrapping keep what is inside it from overflowing.

- [x] **Step 5: Run and re-measure.** `npm run build:test && node ./dist/test-runner/run-tests.js chat-layout-css`. Expected: 6 PASS. Re-run the Step 1 console probe on the reloaded page. Expected: `true`. Also check by eye that:
  - An approved long command shows as one ellipsized line.
  - A long approval card command wraps inside the card.
  - A wide table scrolls on its own.

---

### Task 9: Compaction boundary rule

Live rows re-fold persisted rows only when the live run streams a compaction summary or a row already folded into one. Otherwise, rendering the persisted segments and then the live segments gives the same result as segmenting the combined list.

**Files:**
- Modify: `dashboard/src/lib/compaction-segments.ts`
- Test: `dashboard/tests/lib/compaction-segments.test.ts`

- [x] **Step 1: Write the failing test.** In `dashboard/tests/lib/compaction-segments.test.ts`, change the import on line 3 to `import { buildCompactionSegments, markEarlierRunsCompacted, refoldsEarlierRows } from '../../src/lib/compaction-segments';` and append the following. It uses the file's existing `msg` builder.

```ts
/** Segments as rendered: fold boundaries and message order, ignoring how adjacent message runs are keyed. */
function renderedShape(segments: ReturnType<typeof buildCompactionSegments>): string[] {
  const shape: string[] = [];
  for (const segment of segments) {
    if (segment.kind === 'compaction') shape.push(`fold(${segment.summary?.id ?? 'orphan'}:${segment.originals.map((m) => m.id).join(',')})`);
    else shape.push(...segment.messages.map((m) => m.id));
  }
  return shape;
}

test('without a live fold, persisted then live segments render like the combined list', () => {
  const persisted = [msg({ id: 'p1' }), msg({ id: 'p2', compressedIntoSummary: true }), msg({ id: 'p3' })];
  const live = [msg({ id: 'l1' }), msg({ id: 'l2' })];
  assert.equal(refoldsEarlierRows(live), false);
  assert.deepEqual(
    [...renderedShape(buildCompactionSegments(persisted)), ...renderedShape(buildCompactionSegments(live))],
    renderedShape(buildCompactionSegments([...persisted, ...live])),
  );
});

test('a streamed compaction summary or folded live row re-folds earlier rows', () => {
  assert.equal(refoldsEarlierRows([msg({ id: 's', kind: 'compaction_summary' })]), true);
  assert.equal(refoldsEarlierRows([msg({ id: 'f', compressedIntoSummary: true })]), true);
});
```

- [x] **Step 2: Run to verify failure.** `npm run build:test`. Expected: the build FAILS because `refoldsEarlierRows` is not exported.

- [x] **Step 3: Implement.** Append to `compaction-segments.ts`:

```ts
/** A live summary or folded row can join persisted folds; without one, persisted segments never depend on live rows. */
export function refoldsEarlierRows(live: readonly ChatMessage[]): boolean {
  return live.some((message) => message.kind === 'compaction_summary' || message.compressedIntoSummary === true);
}
```

- [x] **Step 4: Run to verify pass.** `npm run build:test && node ./dist/test-runner/run-tests.js compaction-segments`. Expected: PASS.

---

### Task 10: ChatTab reads slices; memoized transcripts take the per-token work

**Files:**
- Modify: `dashboard/src/tabs/ChatTab.tsx`
- Test: `dashboard/tests/chat-tab.test.tsx`

- [x] **Step 1: Write the failing isolation tests.** Append them to `dashboard/tests/chat-tab.test.tsx`. `buildProps`, `buildDefaultStore`, `SESSION_A`, `msg`, `chatSnapshot`, `createLiveMessage` and `OPERATION_ID` already exist in the file. Add these imports:
  - `import { countRenders } from './render-tracker.js';`, after the `react-test-environment` import.
  - `import { ChatRuntimeHub } from '../src/lib/chat-runtime-hub';`
  - `import { MessageImages } from '../src/components/MessageImages';`
  - `waitFor` in the `./react-test-environment.js` import.

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

test('a composer edit re-renders the shell but neither transcript', async () => {
  const history = [msg({ id: 'u1', role: 'user', kind: 'user_text', content: 'question' }), msg({ id: 'a1', kind: 'assistant_answer', content: 'answer' })];
  const hub = new ChatRuntimeHub(buildDefaultStore(SESSION_A.id));
  const view = renderComponent(<ChatTab {...buildProps({ selectedSession: { ...SESSION_A, messages: history }, runtimeHub: hub })} />);
  try {
    const shellRenders = await countRenders(ChatTab, async () => {
      await act(async () => hub.apply({ kind: 'draft', sessionId: SESSION_A.id, draft: 't' }));
    });
    const historyRenders = await countRenders(MessageImages, async () => {
      await act(async () => hub.apply({ kind: 'draft', sessionId: SESSION_A.id, draft: 'ty' }));
    });
    assert.equal(shellRenders, 1);
    assert.equal(historyRenders, 0);
  } finally { view.unmount(); }
});
```

`as const` is allowed by the repo rules. `MessageImages` renders inside every user bubble, so a re-render of the history shows up as a count above zero.

- [x] **Step 2: Run to verify failure.** `npm run build:test`. Expected: the build FAILS because `runtimeHub` is not a ChatTab prop.

- [x] **Step 3: Change the props contract.**
  - In `ChatTabProps`, delete `selectedRuntime: ChatSessionRuntime | null;` and `sessionRuntimes: ChatSessionRuntime[];`, and add `runtimeHub: ChatRuntimeHub;`.
  - In the `ChatTab({ ... })` destructuring, replace `selectedRuntime, sessionRuntimes,` with `runtimeHub,`.

- [x] **Step 4: Session indicators read the store.** Replace `buildSessionIndicators(sessions, sessionRuntimes)` and its definition with:

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

- [x] **Step 5: Shell slices.** Replace the block from `const planRepoRootInput = selectedRuntime?.planRepoRootInput ?? '';` through the `useChatScroll(...)` call with:

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
  // A streamed fold re-folds persisted rows, so the live transcript then renders them too.
  const persistedSegments = React.useMemo(
    () => liveRefoldsHistory ? [] : buildCompactionSegments(persistedMessages), [persistedMessages, liveRefoldsHistory]);
  const promptContext = selectedSession?.promptContext ?? null;
  const { chatLogRef, chatContentRef, onChatLogScroll, jumpToBottom, showJumpToBottom } = useChatScroll(
    selectedSessionId,
    shell?.pendingApproval?.approvalId ?? questionId,
  );
```

Add a module constant `const NO_MESSAGES: ChatMessage[] = [];` near the other top-level constants. Then, throughout the rest of `ChatTab`:
- `isSessionBusy(selectedRuntime)` → `isSessionBusy(shell)`
- `selectedRuntime?.queue` → `shell?.queue`
- `selectedRuntime?.activity.kind === 'local'` → `shell?.activity.kind === 'local'`
- `selectedRuntime?.awaitingResponse` → `shell?.awaitingResponse`
- `selectedRuntime?.submissionPhase` → `shell?.submissionPhase`
- The repo-agent approval-mode control becomes `chatMode === 'repo-agent' && shell ? (... value={shell.repoAgentApprovalMode} disabled={shell.activity.kind !== 'idle' && !hasActiveRepoAgentRun(shell)} ...)`.
- `const hasCompactableHistory = persistedMessages.some((message) => message.kind !== 'compaction_summary' && message.compressedIntoSummary !== true);`. A run in progress already disables Compact through `selectedSessionBusy`.
- Delete `liveMessages`, `liveTokenDisplays`, `snapshot`, `currentMessages`, `segments`, `visibleMessages`, `liveMessageIds` and `pendingUserMessageId`. All of them move into `LiveTranscript`.

- [x] **Step 6: Memoized transcripts.** Inside `.msgs-content`, replace the `{segments.map((segment) => ...)}` block with:

```tsx
              <PersistedTranscript segments={persistedSegments} {...transcriptRows} />
              <LiveTranscript runtimeHub={runtimeHub} leadingMessages={liveRefoldsHistory ? persistedMessages : NO_MESSAGES}
                retainedIds={retainedIds} {...transcriptRows} />
```

In the shell, above `return`, add: `const transcriptRows = { sessionId: selectedSessionId, isDirectChatMode, chatBusy: selectedSessionBusy, onDeleteMessage, onDeleteMessageImage, onDeleteTurn };`.

Add the module constants `const NO_IDS: ReadonlySet<string> = new Set();` and `const NO_TOKEN_DISPLAYS: ReadonlyMap<string, TokenDisplay> = new Map();`.

Replace the approval card `selectedRuntime?.journalSnapshot?.approval?.actionable ? (... key={selectedRuntime.journalSnapshot.approval.approvalId} approval={selectedRuntime.journalSnapshot.approval} ...)` with `actionableApproval ? (<RepoAgentApprovalCard key={actionableApproval.approvalId} approval={actionableApproval} ... />)`. Change the question card the same way to use `actionableQuestion`.

Add next to `TurnList`:

```tsx
type TranscriptRowProps = {
  sessionId: string;
  isDirectChatMode: boolean;
  chatBusy: boolean;
  onDeleteMessage(messageId: string): Promise<void>;
  onDeleteMessageImage(messageId: string, imageIndex: number): Promise<void>;
  onDeleteTurn(messageIds: string[]): Promise<void>;
};

/** Stored history; memoized so composer edits and stream frames never reconcile it. */
const PersistedTranscript = React.memo(function PersistedTranscript({ segments, ...rows }: TranscriptRowProps & { segments: CompactionSegment[] }) {
  return segments.map((segment) => segment.kind === 'compaction'
    ? <CompactedHistoryPanel key={segment.key} compactedMessages={segment.originals} summary={segment.summary} {...rows} />
    : <TurnList key={segment.key} messages={segment.messages} liveMessageIds={NO_IDS} liveTokenDisplays={NO_TOKEN_DISPLAYS}
      pendingUserMessageId={null} {...rows} />);
});

/** The running operation's rows: the only transcript part that subscribes to per-token runtime changes. */
const LiveTranscript = React.memo(function LiveTranscript({ runtimeHub, leadingMessages, retainedIds, ...rows }: TranscriptRowProps & {
  runtimeHub: ChatRuntimeHub;
  leadingMessages: ChatMessage[];
  retainedIds: ReadonlySet<string>;
}) {
  const live = useChatRuntimeSelector(runtimeHub, (store) => selectLiveTranscript(store, rows.sessionId), sameLiveTranscript);
  const liveMessages = React.useMemo(
    () => (live?.liveMessages ?? NO_MESSAGES).filter((message) => !retainedIds.has(message.id)), [live, retainedIds]);
  const liveMessageIds = React.useMemo(() => new Set(liveMessages.map((message) => message.id)), [liveMessages]);
  const liveTokenDisplays = React.useMemo(() => live ? buildLiveTokenDisplays(live) : NO_TOKEN_DISPLAYS, [live]);
  const pendingUserMessageId = live?.awaitingResponse ? LIVE_USER_MESSAGE_ID : null;
  return buildCompactionSegments([...leadingMessages, ...liveMessages]).map((segment) => segment.kind === 'compaction'
    ? <CompactedHistoryPanel key={`live:${segment.key}`} compactedMessages={segment.originals} summary={segment.summary} {...rows} />
    : <TurnList key={`live:${segment.key}`} messages={segment.messages} liveMessageIds={liveMessageIds}
      liveTokenDisplays={liveTokenDisplays} pendingUserMessageId={pendingUserMessageId} {...rows} />);
});
```

The scroll following needs nothing from `LiveTranscript`: the `ResizeObserver` from Task 7 sees the growth.

- [x] **Step 7: Live context meter components.** `streamedCharsSinceBase` changes per token, so only these three leaves subscribe to it. Add next to `SettingsPopover`:

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

`resolveLiveContextUsage` already returns `ratio`, as today's `liveContextUsage?.ratio` shows. Make these replacements in the composer:
- Replace the `{liveContextUsage ? (<div className=... ctx ...>) : null}` block with `<LiveContextBar runtimeHub={runtimeHub} sessionId={selectedSessionId} shell={shell} busy={selectedSessionBusy} />`.
- Replace the `{liveContextUsage ? (<span className="ctx-label">...) : null}` block with `<LiveContextLabel ... />`, using the same props.
- Replace `<ChatStatsBar ... />` with `<LiveChatStatsBar runtimeHub={runtimeHub} sessionId={selectedSessionId} shell={shell} busy={selectedSessionBusy} lastTurn={lastTurnTelemetry} sessionStats={sessionPromptCacheStats} />`.
- Delete `liveContextUsage`, `usedRatio` and `contextTone` from the shell.

Imports to add in `ChatTab.tsx`:
- `ChatRuntimeHub` (type)
- `useChatRuntimeSelector`
- from `../lib/chat-runtime-selectors`: `selectRuntime`, `selectShellRuntime`, `sameShellRuntime`, `selectLiveTranscript`, `sameLiveTranscript`, `selectLiveMessages`, `selectLiveOperationId`, `selectCompactedEarlierHistory`, `selectActionableApproval`, `selectActionableQuestion`, `selectQuestionId`, `selectStreamedCharsSinceBase`, and type `ChatShellRuntime`
- `refoldsEarlierRows` and type `CompactionSegment`
- type `ChatSessionRuntimeStore`

Remove imports that become unused, such as type `ChatSessionRuntime`. Lint fails on them.

- [x] **Step 8: Migrate `chat-tab.test.tsx`.** Apply these rules to all 116 matches:
  - In `buildProps`, replace `selectedRuntime: defaultStore.get(selectedSessionId), sessionRuntimes: defaultStore.getAll(),` with `runtimeHub: new ChatRuntimeHub(defaultStore),`.
  - An override `{ selectedRuntime: store.get(id), sessionRuntimes: store.getAll() }`, or either key alone, becomes `{ runtimeHub: new ChatRuntimeHub(store) }`. This includes the `renderToStaticMarkup` tests; `useSyncExternalStore` reads the server snapshot there.
  - A test that re-renders ChatTab with a newer store to simulate streaming creates one hub up front. It then calls `await act(async () => { hub.update(() => nextStore); notifyResize(); })` instead of `rerender` with new runtime props. Keep the `notifyResize()` that Task 7 added wherever the log should follow.
  - Do not weaken any assertion. If a test fails, the migration or the implementation is wrong. Fix the code, not the expectation.

- [x] **Step 9: Delete what the split made unused.** Check `rg -n "buildLiveMessageScrollSignature|selectedRuntime|sessionRuntimes" dashboard/src dashboard/tests`. Expected: no matches.

- [x] **Step 10: Compile and run.** `npm run build:test && node ./dist/test-runner/run-tests.js chat-tab useChatSessions app-shell`. Expected: all PASS, including `shellRenders === 0`, and `shellRenders === 1` with `historyRenders === 0`.

---

### Task 11: Projection appends without a whole-message parse

**Files:**
- Modify: `dashboard/src/lib/chat-operation-projection.ts` (`case 'append_text':` in `stageRecord`)
- Test: `dashboard/tests/chat-operation-projection.test.ts`

- [x] **Step 1: Write the failing test.** Append it to `dashboard/tests/chat-operation-projection.test.ts`. It uses the file's existing `message`, `capture`, `feed`, `stateOf`, `operationId` and `nextTransferId` helpers and imports.

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

- [x] **Step 2: Run to verify failure.** `npm run build:test && node ./dist/test-runner/run-tests.js chat-operation-projection`. Expected: the second test FAILS, because today's zod parse throws a zod error, not `re-kinds a non-assistant row`. The first test passes; it guards the success path.

- [x] **Step 3: Implement.** Replace the `append_text` case body and add the helper:

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
  // Narrowing metadata.kind does not narrow a spread of metadata, so kind is restated for the union member.
  if (metadata.kind === 'assistant_narration' || metadata.kind === 'assistant_progress') {
    if (existing.role !== 'assistant') fail('append re-kinds a non-assistant row');
    return { ...existing, ...metadata, kind: metadata.kind, role: 'assistant', content };
  }
  return { ...existing, ...metadata, kind: metadata.kind, content };
}
```

Import `type ChatTextRowMetadata` from `@siftkit/contracts`. Drop the `ChatTranscriptMessageSchema` and `ChatTextRowKindSchema` imports if they are now unused. No casts.

- [x] **Step 4: Run to verify pass.** Same command. Expected: all PASS.

---

### Task 12: Full verification

- [x] **Step 1:** `npm run build:test && node ./dist/test-runner/run-tests.js --dashboard`. Expected: `ℹ fail 0`.
- [x] **Step 2:** `npm run typecheck`. Expected: exit 0 (includes lint).
- [x] **Step 3: Scope check.**
  - `git diff --stat` touches only the files in the File Structure table.
  - `rg -n "selectedRuntime|sessionRuntimes|setRuntimeStore|runtimeStoreRef|buildLiveMessageScrollSignature|hashFnv1a32|liveMessageScrollSignature" dashboard/src dashboard/tests` returns nothing. This confirms a complete replacement with no leftovers.
- [ ] **Step 4: Manual scroll check (report, don't gate).** With the dev server, stream a long answer with thinking into a chat session. Confirm each of the following:
  - The log stays at the bottom through the smoothed reveal and the final snap.
  - Scrolling up mid-stream stays put, and "Jump to bottom" appears.
  - Jumping re-pins, and following resumes.
  - Growing the composer textarea while pinned keeps the last line visible.
- [ ] **Step 5: Manual overflow check (report, don't gate).** In a repo-agent session, approve a long command and reject another. `.msgs` shows no horizontal scrollbar, the decision rows ellipsize, and the Task 8 console probe returns `true`.
- [ ] **Step 6: Manual profile (report, don't gate).** Open a long session while a model streams and record a Chrome Performance profile for about 10 s.
  - Expected: per-token commits contain `LiveTranscript` and the live context leaves only. `App` and `ChatTab` appear only on non-token events such as submit, terminal and queue changes.
  - Report the script time per second next to the baseline in this plan's Background section.

---

## Drift fixes (post-review, 2026-09-28)

Review findings 1-10, 12, 13 from `/reflect-session-drift`. TDD per item; do not commit.

- [x] **D1 (#2, #3, #6, #12) Store splits into `runtime` + `live`.** `ChatSessionRuntimeStore` holds two maps. `runtimes` holds the slow fields plus the derived `indicator` and `liveClosesFold`. `lives` holds `journalSnapshot`, `liveMessages`, `tokenTurns` and `streamedCharsSinceBase`. `apply` keeps each half's identity when nothing in it changes, via one `shallowEqual`/`reuse` helper that also replaces `sameActivity`/`sameStrings`. `apply` returns the same store when nothing changed. Selectors return only store-owned values, so `useChatRuntimeSelector` needs no cache and no equality argument. `SHELL_KEYS`, `selectShellRuntime`, `sameShellRuntime`, `selectLiveTranscript`, `sameLiveTranscript`, `sameSessionIndicators` and `getAll` are deleted. The rail derives indicators from `runtime.indicator`.
- [x] **D2 (#4) Hub API without updater functions:** `apply(...transitions)`, `ensureSession`, `removeSession`; `update` is deleted. Duplicate response handling in `useChatSessions` reuses `applySessionResponse`.
- [x] **D3 (#1) chat-tab streaming tests drive one hub** with `hub.apply(...)`, not a new hub per re-render.
- [x] **D4 (#7) Stable row actions:** ChatTab passes the memoized transcripts one stable actions object that reads the latest handlers. A test re-renders with new handler identities and expects 0 history renders.
- [x] **D5 (#8) Only the rows after the last stored summary move.** A live summary unavoidably re-orders them. `splitAfterLastSummary(persisted)` sends `settled` rows to `PersistedTranscript` always, and only the `open` tail joins `LiveTranscript` while `runtime.liveClosesFold`. The invariant is covered by a test.
- [x] **D6 (#13)** `useChatScroll` returns one callback ref for `.msgs`. It observes the log and its content wrapper, fails loudly if the wrapper is missing, and keeps no ref-passing helper.
- [x] **D7 (#9, #10) Real-browser overflow test.** `tests/process/chat-overflow.test.ts` lives in the process suite, because the default suite forbids child processes. It bundles `dashboard/tests/chat-overflow-page.tsx` with esbuild in memory. The page renders the real ChatTab in question, approval and orchestrator scenarios, with hostile content and all disclosures opened; `dashboard/tests/chat-tab-fixture.ts` now shares `buildProps` with chat-tab tests. The test serves the page and one orchestrator run over local HTTP. `chrome --headless=new --virtual-time-budget --dump-dom` loads it, and Chrome's temporary profile is removed on exit. The test asserts no sideways scroll and nothing escaping its bubble. Mutations confirm it catches removing `.approval-actions > *`, `minmax(0, 1fr)` or `overflow-wrap: anywhere`. `chat-layout-css.test.ts` is deleted. `.send`/`.mini-btn` drop `flex: none`; only the composer row and `.err-banner` pin their buttons. `.approval-actions > *` is deleted.
- [x] **D9 (#5)** `appendTextRow` rejects non-text rows via `ChatTextRowKindSchema`, not a hardcoded kind list; covered by a compaction-summary append test.
- [x] **D8** Full suite, typecheck and lint.

---

## Streaming load and render cost (2026-09-28)

`npm run test:perf` runs `tests/perf/chat-stream-load.test.ts`: the real server encoder streams 1,000 tokens at 100/s over SSE into the real stream client, runtime hub and `ChatTab` in headless Chrome, and DevTools reports main-thread and per-process CPU. The `perf` suite runs one file at a time and no other run includes it.

- [x] **P1 Off-screen history is skipped.** A trace showed every past row revisited per frame (compositing inputs for each code-block and table scroller, layout, paint). `.msgs-content > *` gets `content-visibility: auto`.
- [x] **P2 History is chunked.** `chunkAtTurnStarts` wraps settled rows in chunks of `HISTORY_CHUNK_MESSAGES`, cut only where turn grouping starts a turn and keyed by the first row, so per-frame work follows chunks. A chunk's placeholder height is `--row-estimate × --chunk-rows`, with `--chunk-rows` set from the TS constant.
- [x] **P3 Block flow, not grid.** A growing live row re-lays out only itself; bubbles align with `width: fit-content` and `margin-left: auto`.
- [x] **P4 `formatNumber` reuses one `Intl.NumberFormat`.**
- [x] **P5 Measured, not adopted:** render coalescing per animation frame (about 10–15%, inside run-to-run noise).
- Result: about 1.1 ms of main thread per token for 0, 200 and 1,000 history rows (was 2.0 at 200); 60 fps; no long tasks. The test fails if a long history costs over 1.25× the empty one.

### Drift fixes, round 2

- [x] **E1** `ownedStreamTransitions` is the one step `useChatSessions` and the load page apply per transition.
- [x] **E2** One Chrome driver: `HeadlessChrome`/`BrowserPage` in `tests/helpers/browser-page.ts` with one flag list; both browser tests use it, and `bundleResponse` serves bundles (404 for unknown ones).
- [x] **E3** Load scenarios have typed ids; a missing measurement fails loudly.
- [x] **E4** `startsUserTurn` is the only turn-start rule, shared by grouping and chunking.
- [x] **E5** The chunk estimate derives from the chunk size; the overflow test checks it resolves.
- [x] **E6** The overflow test asserts bubble alignment and that short bubbles hug their content, and checks escapes generically (no box past its parent unless the parent scrolls or it is out of flow).
- [x] **E7** Timing assertions live in the serial `perf` suite.
