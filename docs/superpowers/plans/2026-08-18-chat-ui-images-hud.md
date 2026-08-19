# Chat UI: Optimistic Bubbles, Clipboard Images, Lightbox, Image Token Accounting, Perf HUD — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard chat show submitted messages and images immediately, accept pasted images, enlarge images inline, account for and delete image tokens, and display a performance HUD under the composer.

**Architecture:** Dashboard work is React plus a copy-on-write runtime store (`ChatSessionRuntimeStore`); new UI is small focused components (`ImageLightbox`, `ChatStatsBar`) plus pure helpers in `dashboard/src/lib/`. Server work threads the already-computed `ImageMetadata` from image admission onto persisted user messages, folds `tokenEstimate` into `ContextUsage`, and adds one per-image DELETE route modelled on the existing image-caption mutation.

**Tech Stack:** TypeScript (strict; no `any`, no type assertions, no non-null assertions in production code), React 19, Zod contracts in `packages/contracts`, `node:test` + `@testing-library/react`, better-sqlite3 runtime DB.

**Spec:** `docs/superpowers/specs/2026-08-18-chat-ui-images-hud-design.md`

**Test commands:**
- Build tests once, then run a subset: `npm run build:test` then `node .\dist\test-runner\run-tests.js <file-stem>`
- Full dashboard suite: `npm run test:dashboard`
- Full suite: `npm run test`
- Gate: `npm run typecheck` (this also runs `npm run lint`)

Route large output through SiftKit:
`npm run test 2>&1 | siftkit summary --question "Return pass/fail, failing tests, root errors, and relevant file:line anchors."`

---

## File Structure

**Created**
- `dashboard/src/lib/clipboard-images.ts` — pure extraction of image `File`s from a clipboard payload
- `dashboard/src/components/ImageLightbox.tsx` — modal image viewer
- `dashboard/src/components/ChatStatsBar.tsx` — performance HUD strip
- `dashboard/tests/clipboard-images.test.ts`
- `dashboard/tests/image-lightbox.test.tsx`
- `dashboard/tests/chat-stats-bar.test.tsx`

**Modified**
- `dashboard/src/lib/chat-session-runtime-store.ts` — `submit` transition, `submittedInput`
- `dashboard/src/lib/chat-live-messages.ts` — `LIVE_USER_MESSAGE_ID`, `buildLiveUserMessage`
- `dashboard/src/hooks/useChatSessions.ts` — apply `submit` before streaming; `deleteMessageImage`
- `dashboard/src/hooks/useChatController.ts` — wire `onDeleteMessageImage`, `lastTurnTelemetry`
- `dashboard/src/tabs/ChatTab.tsx` — `File[]` image reads, paste handler, pending bubble, stats bar, image-delete prop, popover image line
- `dashboard/src/components/MessageImages.tsx` — lightbox trigger, per-image delete
- `dashboard/src/components/PendingImageStrip.tsx` — lightbox trigger, loading skeletons
- `dashboard/src/lib/format.ts` — `getMessageImageTokenCount`, `getLastTurnTelemetry`
- `dashboard/src/api.ts` — `deleteChatMessageImage`
- `dashboard/src/styles/chat.css` — lightbox, stats bar, pending/skeleton styles
- `packages/contracts/src/chat.ts` — `ContextUsageSchema.imageUsedTokens`
- `src/status-server/chat.ts` — `AppendChatOptions.imageMeta`, image tokens in context usage
- `src/status-server/routes/chat.ts` — admit metadata, thread it, new delete-image endpoint + route
- `src/status-server/chat-repo-operation-runner.ts` — keep admitted metadata
- `src/state/chat-sessions.ts` — `deleteChatMessageImage`

**Existing test helpers to reuse (do not reinvent):**
- `dashboard/tests/chat-tab.test.tsx` — `IMAGE`, `IMAGE_META`, `msg()`, `SESSION_A`, `CONTEXT_USAGE`, `buildDefaultStore()`, `buildProps()`, `render()` (returns markup string), `installImageReadControls()`, `renderComponent`, `screen`, `fireEvent`
- `dashboard/tests/message-images.test.tsx` — `PNG_A`, `PNG_B`, `META`, `render`, `screen`, `fireEvent`
- `tests/status-server-chat-routes.test.ts` — `imageMetadata()`, `seedCaptionSession()`, `withCaptionServer()`, `closeCaptionTestServer()`, `createManagedTempDir`, `createTestChatSession`, `saveChatSession`, `readChatSessionFromPath`, `getChatSessionPath`, `requestJson`, `asObject`
- `tests/status-server-chat.test.ts` — `createConfig()`, `mockChatSession()`, `buildContextUsage`

---

## Task 1: `submit` transition in the chat runtime store

**Files:**
- Modify: `dashboard/src/lib/chat-live-messages.ts:29`
- Modify: `dashboard/src/lib/chat-session-runtime-store.ts:18-30,32-44,46-60,83-128`
- Test: `dashboard/tests/chat-session-runtime-store.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `dashboard/tests/chat-session-runtime-store.test.ts` (the file already defines `IMAGE_A`, `IMAGE_B`, `SAMPLE_RESPONSE`):

```ts
test('submit moves the draft and images into a live user bubble', () => {
  const next = new ChatSessionRuntimeStore()
    .apply({ kind: 'draft', sessionId: 's1', draft: 'look at this' })
    .apply({ kind: 'append-images', sessionId: 's1', images: [IMAGE_A] })
    .apply({ kind: 'submit', sessionId: 's1', content: 'look at this', images: [IMAGE_A] });

  const runtime = next.get('s1');
  assert.equal(runtime.draft, '');
  assert.deepEqual(runtime.pendingImages, []);
  assert.equal(runtime.liveMessages.length, 1);
  assert.equal(runtime.liveMessages[0]?.id, 'live-user');
  assert.equal(runtime.liveMessages[0]?.role, 'user');
  assert.equal(runtime.liveMessages[0]?.content, 'look at this');
  assert.deepEqual(runtime.liveMessages[0]?.images, [IMAGE_A.dataUrl]);
  assert.deepEqual(runtime.submittedInput, { content: 'look at this', images: [IMAGE_A] });
});

test('submit keeps the live user bubble first when the answer starts streaming', () => {
  const next = new ChatSessionRuntimeStore()
    .apply({ kind: 'submit', sessionId: 's1', content: 'hi', images: [] })
    .apply({ kind: 'answer', sessionId: 's1', delta: { turn: 1, offset: 0, text: 'hello' } });

  assert.deepEqual(
    next.get('s1').liveMessages.map((message) => message.id),
    ['live-user', 'live-answer'],
  );
});

test('failure restores the submitted draft and images and drops the live bubble', () => {
  const next = new ChatSessionRuntimeStore()
    .apply({ kind: 'submit', sessionId: 's1', content: 'look at this', images: [IMAGE_A, IMAGE_B] })
    .apply({ kind: 'failure', sessionId: 's1', message: 'engine unavailable' });

  const runtime = next.get('s1');
  assert.equal(runtime.draft, 'look at this');
  assert.deepEqual(runtime.pendingImages, [IMAGE_A, IMAGE_B]);
  assert.deepEqual(runtime.liveMessages, []);
  assert.equal(runtime.submittedInput, null);
  assert.equal(runtime.error, 'engine unavailable');
});

test('failure without a submitted input leaves the composer untouched', () => {
  const next = new ChatSessionRuntimeStore()
    .apply({ kind: 'draft', sessionId: 's1', draft: 'typed but never sent' })
    .apply({ kind: 'failure', sessionId: 's1', message: 'boom' });

  assert.equal(next.get('s1').draft, 'typed but never sent');
  assert.deepEqual(next.get('s1').pendingImages, []);
});

test('done clears the submitted input along with the live messages', () => {
  const next = new ChatSessionRuntimeStore()
    .apply({ kind: 'submit', sessionId: 's1', content: 'hi', images: [IMAGE_A] })
    .apply({ kind: 'done', sessionId: 's1', response: SAMPLE_RESPONSE });

  assert.equal(next.get('s1').submittedInput, null);
  assert.deepEqual(next.get('s1').liveMessages, []);
  assert.deepEqual(next.get('s1').pendingImages, []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js chat-session-runtime-store`
Expected: FAIL — the `submit` transition kind is not assignable and `submittedInput` does not exist.

- [ ] **Step 3: Add the live user message builder**

In `dashboard/src/lib/chat-live-messages.ts`, after `createLiveMessage` (line 29):

```ts
export const LIVE_USER_MESSAGE_ID = 'live-user';

export function buildLiveUserMessage(content: string, imageDataUrls: string[]): ChatMessage {
  return {
    ...createLiveMessage(LIVE_USER_MESSAGE_ID, 'user_text', 'user', content),
    images: imageDataUrls,
  };
}
```

- [ ] **Step 4: Add the transition and the runtime field**

In `dashboard/src/lib/chat-session-runtime-store.ts`, extend the import block (lines 2-7):

```ts
import {
  buildAppendedLiveToolMessage,
  buildCompletedLiveToolMessage,
  buildLiveUserMessage,
  createLiveMessage,
  upsertLiveMessageInto,
} from './chat-live-messages';
```

Add the payload type above `ChatSessionRuntime`:

```ts
export type SubmittedChatInput = { content: string; images: PendingImage[] };
```

Add `submittedInput: SubmittedChatInput | null;` to `ChatSessionRuntime` directly after `pendingImages`.

Add the transition variant to `ChatSessionRuntimeTransition`:

```ts
  | { kind: 'submit'; sessionId: string; content: string; images: PendingImage[] }
```

Seed the field in `createChatSessionRuntime`, after `pendingImages: []`:

```ts
    submittedInput: null,
```

Add the `submit` case to `applyTransition`:

```ts
    case 'submit':
      return {
        ...runtime,
        error: null,
        draft: '',
        pendingImages: [],
        submittedInput: { content: transition.content, images: transition.images },
        liveMessages: upsertLiveMessageInto(
          runtime.liveMessages,
          buildLiveUserMessage(transition.content, transition.images.map((image) => image.dataUrl)),
        ),
      };
```

Replace the `done` case:

```ts
    case 'done':
      return {
        ...runtime,
        activity: { kind: 'idle' },
        contextUsage: transition.response.contextUsage,
        liveMessages: [],
        error: null,
        draft: '',
        pendingImages: [],
        submittedInput: null,
      };
```

Replace the `failure` case:

```ts
    case 'failure':
      return {
        ...runtime,
        activity: { kind: 'idle' },
        error: transition.message,
        liveMessages: [],
        draft: runtime.submittedInput ? runtime.submittedInput.content : runtime.draft,
        pendingImages: runtime.submittedInput ? runtime.submittedInput.images : runtime.pendingImages,
        submittedInput: null,
      };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js chat-session-runtime-store`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/lib/chat-session-runtime-store.ts dashboard/src/lib/chat-live-messages.ts dashboard/tests/chat-session-runtime-store.test.ts
git commit -m "feat(chat): add submit transition that moves the composer into a live user bubble"
```

---

## Task 2: Send paths apply `submit`; the composer renders a pending bubble

**Files:**
- Modify: `dashboard/src/hooks/useChatSessions.ts:350-415`
- Modify: `dashboard/src/tabs/ChatTab.tsx:230-232,350-364,536-568,621-638,680-706`
- Modify: `dashboard/src/styles/chat.css`
- Test: `dashboard/tests/chat-tab.test.tsx`

- [ ] **Step 1: Write the failing pending-bubble test**

Append to `dashboard/tests/chat-tab.test.tsx`:

```tsx
test('a submitted message renders as a pending bubble instead of staying in the composer', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession(SESSION_A.id)
    .apply({ kind: 'context-usage', sessionId: SESSION_A.id, contextUsage: CONTEXT_USAGE })
    .apply({ kind: 'begin', sessionId: SESSION_A.id, operationKind: 'message' })
    .apply({ kind: 'submit', sessionId: SESSION_A.id, content: 'describe this', images: [{ dataUrl: IMAGE, note: null }] });
  const markup = render({
    selectedRuntime: store.get(SESSION_A.id),
    sessionRuntimes: store.getAll(),
  });

  assert.match(markup, /class="msg user user_text live pending"/u);
  assert.match(markup, /sending…/u);
  assert.match(markup, /describe this/u);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js chat-tab`
Expected: FAIL — no `pending` class and no `sending…` text.

- [ ] **Step 3: Apply `submit` in the three send paths**

In `dashboard/src/hooks/useChatSessions.ts`, add a helper directly above `sendMessage` (line 350):

```ts
  function submitRuntimeInputs(sessionId: string, content: string, images: PendingImage[]): void {
    setRuntimeStore((previous) => previous.apply({ kind: 'submit', sessionId, content, images }));
  }
```

Insert `submitRuntimeInputs(selectedSession.id, inputs.draft, inputs.pendingImages);` immediately before the `await runChatStream(` call in `sendMessage` (line 379).

Insert `submitRuntimeInputs(session.id, inputs.draft, inputs.pendingImages);` immediately before the `await runChatStream(` call in `sendPlan` (line 395) and in `sendRepoSearch` (line 409).

- [ ] **Step 4: Render the pending state**

In `dashboard/src/tabs/ChatTab.tsx`, import the constant:

```tsx
import { LIVE_USER_MESSAGE_ID } from '../lib/chat-live-messages';
```

Derive the flag after `const selectedSessionBusy = isSessionBusy(selectedRuntime);` (line 232):

```tsx
  const pendingUserMessageId = selectedRuntime?.submittedInput
    && liveMessages.length === 1
    && liveMessages[0]?.id === LIVE_USER_MESSAGE_ID
    ? LIVE_USER_MESSAGE_ID
    : null;
```

Replace `MessageHeader` (lines 536-568):

```tsx
function MessageHeader({ message, isLive, isPending, chatBusy, onDeleteMessage }: {
  message: ChatMessage;
  isLive: boolean;
  isPending: boolean;
  chatBusy: boolean;
  onDeleteMessage(messageId: string): Promise<void>;
}) {
  const messageKind = normalizeMessageKind(message);
  const messageLabel = messageKind === 'assistant_thinking'
    ? 'assistant thinking'
    : messageKind === 'assistant_tool_call'
      ? 'assistant tool'
      : message.role === 'user' ? 'You' : 'SiftKit';
  return (
    <div className="who">
      <span>{messageLabel} · {isPending ? 'sending…' : isLive ? 'live' : formatDate(message.createdAtUtc)}</span>
      <span className="msg-meta">
        {isPending ? <span className="sp" /> : null}
        <span className="msg-tokens">{formatTokenLabel(getReplayDisplayTokenCount(message))}</span>
        {!isLive ? (
          <button
            type="button"
            className="msg-icon-button danger"
            onClick={() => { void onDeleteMessage(message.id); }}
            disabled={chatBusy}
            aria-label="Delete message"
            title="Delete message"
          >
            &#128465;
          </button>
        ) : null}
      </span>
    </div>
  );
}
```

Replace `MessageBubble` (lines 621-638):

```tsx
function MessageBubble({ message, sessionId, isLive, isPending, isDirectChatMode, chatBusy, onDeleteMessage, extraClass }: {
  message: ChatMessage;
  sessionId: string;
  isLive: boolean;
  isPending: boolean;
  isDirectChatMode: boolean;
  chatBusy: boolean;
  onDeleteMessage(messageId: string): Promise<void>;
  extraClass?: string;
}) {
  const messageKind = normalizeMessageKind(message);
  const tone = message.role === 'user' ? 'user' : 'ai';
  return (
    <article className={`msg ${tone} ${messageKind}${extraClass ? ` ${extraClass}` : ''}${isLive ? ' live' : ''}${isPending ? ' pending' : ''}`}>
      <MessageHeader message={message} isLive={isLive} isPending={isPending} chatBusy={chatBusy} onDeleteMessage={onDeleteMessage} />
      {renderMessageBody(message, sessionId, isDirectChatMode, isLive)}
    </article>
  );
}
```

Pass `isPending={message.id === pendingUserMessageId}` at the single-message call site (line 355). Pass `isPending={false}` at the two `MessageBubble` call sites inside `ChatTurnBubble` (lines 684 and 697) — an aggregated turn never holds the pending user bubble.

- [ ] **Step 5: Add the pending styles**

Append to `dashboard/src/styles/chat.css`:

```css
.msg.pending { opacity: 0.72; }
.msg.pending .who { color: var(--dim); }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js chat-tab`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/hooks/useChatSessions.ts dashboard/src/tabs/ChatTab.tsx dashboard/src/styles/chat.css dashboard/tests/chat-tab.test.tsx
git commit -m "feat(chat): show submitted messages as a pending bubble instead of holding them in the composer"
```

---

## Task 3: Paste images from the clipboard

**Files:**
- Create: `dashboard/src/lib/clipboard-images.ts`
- Create: `dashboard/tests/clipboard-images.test.ts`
- Modify: `dashboard/src/tabs/ChatTab.tsx:159-166,239-255,439-463`
- Test: `dashboard/tests/chat-tab.test.tsx`

Note: `readImageFiles` and `enqueuePendingImageRead` switch from `FileList | null` to `File[]`. jsdom has no `DataTransfer` constructor, and a `File[]` is what both the file input and the clipboard naturally produce.

- [ ] **Step 1: Write the failing helper test**

Create `dashboard/tests/clipboard-images.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { extractClipboardImageFiles } from '../src/lib/clipboard-images';

type ClipboardStub = { items: { kind: string; type: string; getAsFile(): File | null }[] };

const PNG = new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' });

function clipboard(entries: { type: string; file: File | null }[]): ClipboardStub {
  return {
    items: entries.map((entry) => ({ kind: 'file', type: entry.type, getAsFile: () => entry.file })),
  };
}

test('extracts image files from a clipboard payload', () => {
  assert.deepEqual(extractClipboardImageFiles(clipboard([{ type: 'image/png', file: PNG }])), [PNG]);
});

test('ignores text entries so a plain text paste is untouched', () => {
  assert.deepEqual(extractClipboardImageFiles(clipboard([{ type: 'text/plain', file: null }])), []);
});

test('ignores image entries that expose no file', () => {
  assert.deepEqual(extractClipboardImageFiles(clipboard([{ type: 'image/png', file: null }])), []);
});

test('returns nothing when there is no clipboard data', () => {
  assert.deepEqual(extractClipboardImageFiles(null), []);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js clipboard-images`
Expected: FAIL — `Cannot find module '../src/lib/clipboard-images'`.

- [ ] **Step 3: Write the helper**

Create `dashboard/src/lib/clipboard-images.ts`:

```ts
/**
 * The structural slice of a clipboard payload this module needs. Typing the parameter
 * this way keeps the helper testable without constructing a real DataTransfer, which
 * jsdom does not provide.
 */
export type ClipboardImageSource = {
  items: ArrayLike<{ type: string; getAsFile(): File | null }>;
};

/**
 * Pulls pasted bitmaps out of a clipboard payload. Non-image entries are ignored so a
 * normal text paste keeps its default behaviour.
 */
export function extractClipboardImageFiles(clipboardData: ClipboardImageSource | null): File[] {
  if (!clipboardData) {
    return [];
  }
  const files: File[] = [];
  for (const item of Array.from(clipboardData.items)) {
    if (!item.type.startsWith('image/')) {
      continue;
    }
    const file = item.getAsFile();
    if (file) {
      files.push(file);
    }
  }
  return files;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js clipboard-images`
Expected: PASS

- [ ] **Step 5: Write the failing composer test**

Append to `dashboard/tests/chat-tab.test.tsx`:

```tsx
test('pasting an image attaches it and a text paste is left alone', async () => {
  const controls = installImageReadControls();
  const appended: string[] = [];
  try {
    const store = new ChatSessionRuntimeStore()
      .ensureSession(SESSION_A.id)
      .apply({ kind: 'context-usage', sessionId: SESSION_A.id, contextUsage: CONTEXT_USAGE });
    renderComponent(React.createElement(ChatTab, buildProps({
      selectedRuntime: store.get(SESSION_A.id),
      sessionRuntimes: store.getAll(),
      onPendingImagesAppend: (_sessionId, images) => {
        appended.push(...images.map((image) => image.dataUrl));
      },
    })));
    const textarea = screen.getByPlaceholderText('Message SiftKit…');

    const imagePaste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(imagePaste, 'clipboardData', {
      value: {
        items: [{
          kind: 'file',
          type: 'image/png',
          getAsFile: () => new File([new Uint8Array([1])], 'p.png', { type: 'image/png' }),
        }],
      },
    });
    await act(async () => { textarea.dispatchEvent(imagePaste); });
    assert.equal(imagePaste.defaultPrevented, true);
    await act(async () => { controls.complete(0, IMAGE); });
    assert.deepEqual(appended, [IMAGE]);

    const textPaste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(textPaste, 'clipboardData', {
      value: { items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] },
    });
    await act(async () => { textarea.dispatchEvent(textPaste); });
    assert.equal(textPaste.defaultPrevented, false);
  } finally {
    controls.restore();
  }
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `node .\dist\test-runner\run-tests.js chat-tab`
Expected: FAIL — the image paste is not prevented and nothing is appended.

- [ ] **Step 7: Switch the image-read path to `File[]` and wire the paste handler**

In `dashboard/src/tabs/ChatTab.tsx`, import the helper:

```tsx
import { extractClipboardImageFiles } from '../lib/clipboard-images';
```

Replace `readImageFiles` (lines 159-166):

```tsx
export async function readImageFiles(files: File[], maxPixels: number): Promise<PendingImage[]> {
  const results: PendingImage[] = [];
  for (const file of files) {
    results.push(await readImageFile(file, maxPixels));
  }
  return results;
}
```

Replace `enqueuePendingImageRead` (lines 239-255):

```tsx
  function enqueuePendingImageRead(files: File[], maxPixels: number): void {
    if (files.length === 0) {
      return;
    }
    const generation = pendingImageReadState.current.generation;
    const sessionId = selectedSessionId;
    const batch = readImageFiles(files, maxPixels);
    pendingImageReadState.current.tail = pendingImageReadState.current.tail.then(async () => {
      try {
        const images = await batch;
        if (generation === pendingImageReadState.current.generation) {
          onPendingImagesAppend(sessionId, images);
        }
      } catch (error) {
        if (generation === pendingImageReadState.current.generation) {
          onPendingImageError(sessionId, error instanceof Error ? error.message : String(error));
        }
      }
    });
  }
```

Add the paste handler directly below it:

```tsx
  function handleComposerPaste(event: React.ClipboardEvent<HTMLTextAreaElement>): void {
    if (selectedSessionBusy || effectiveImagePixelCeiling === null) {
      return;
    }
    const files = extractClipboardImageFiles(event.clipboardData);
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    enqueuePendingImageRead(files, effectiveImagePixelCeiling);
  }
```

Attach it to the textarea (line 439) by adding `onPaste={handleComposerPaste}` after `onChange`.

Update the file input's handler (lines 456-461) to hand over an array:

```tsx
                    onChange={(event) => {
                      if (effectiveImagePixelCeiling === null) {
                        return;
                      }
                      enqueuePendingImageRead(
                        Array.from(event.currentTarget.files ?? []),
                        effectiveImagePixelCeiling,
                      );
                    }}
```

- [ ] **Step 8: Update the existing `readImageFiles` callers in tests**

`dashboard/tests/message-images.test.tsx` and `dashboard/tests/chat-tab.test.tsx` pass a `FileList`-like value to `readImageFiles`; change those call sites to pass an array of `File`. Find them with `node .\dist\test-runner\run-tests.js message-images` failures.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js chat-tab` and `node .\dist\test-runner\run-tests.js message-images`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add dashboard/src/lib/clipboard-images.ts dashboard/tests/clipboard-images.test.ts dashboard/src/tabs/ChatTab.tsx dashboard/tests
git commit -m "feat(chat): attach images pasted from the clipboard"
```

---

## Task 4: Image lightbox and attachment-read skeletons

**Files:**
- Create: `dashboard/src/components/ImageLightbox.tsx`
- Create: `dashboard/tests/image-lightbox.test.tsx`
- Modify: `dashboard/src/components/MessageImages.tsx:22-107`
- Modify: `dashboard/src/components/PendingImageStrip.tsx`
- Modify: `dashboard/src/tabs/ChatTab.tsx:215,234-237,239-255,425-428`
- Modify: `dashboard/src/styles/chat.css`
- Test: `dashboard/tests/message-images.test.tsx`, `dashboard/tests/pending-image-strip.test.tsx`

- [ ] **Step 1: Write the failing lightbox test**

Create `dashboard/tests/image-lightbox.test.tsx`:

```tsx
import './react-test-environment.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import { ImageLightbox } from '../src/components/ImageLightbox';
import { fireEvent, render, screen } from './react-test-environment.js';

const PNG = 'data:image/png;base64,AA==';

test('renders the image in a modal dialog', () => {
  render(<ImageLightbox src={PNG} alt="Attachment 1" onClose={() => undefined} />);
  const dialog = screen.getByRole('dialog');
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  assert.equal(screen.getByAltText('Attachment 1').getAttribute('src'), PNG);
});

test('closes on the close button, the backdrop, and Escape', () => {
  let closed = 0;
  const view = render(<ImageLightbox src={PNG} alt="Attachment 1" onClose={() => { closed += 1; }} />);

  fireEvent.click(screen.getByLabelText('Close image'));
  assert.equal(closed, 1);

  fireEvent.click(screen.getByRole('dialog'));
  assert.equal(closed, 2);

  fireEvent.keyDown(window, { key: 'Escape' });
  assert.equal(closed, 3);
  view.unmount();
});

test('a click on the image itself does not close the lightbox', () => {
  let closed = 0;
  render(<ImageLightbox src={PNG} alt="Attachment 1" onClose={() => { closed += 1; }} />);
  fireEvent.click(screen.getByAltText('Attachment 1'));
  assert.equal(closed, 0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js image-lightbox`
Expected: FAIL — `Cannot find module '../src/components/ImageLightbox'`.

- [ ] **Step 3: Write the component**

Create `dashboard/src/components/ImageLightbox.tsx`:

```tsx
import React, { useEffect } from 'react';

export function ImageLightbox({ src, alt, onClose }: {
  src: string;
  alt: string;
  onClose(): void;
}) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        onClose();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      onClick={onClose}
    >
      <button
        type="button"
        className="image-lightbox-close"
        aria-label="Close image"
        title="Close image"
        onClick={(event) => { event.stopPropagation(); onClose(); }}
      >
        ×
      </button>
      <img src={src} alt={alt} onClick={(event) => event.stopPropagation()} />
    </div>
  );
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js image-lightbox`
Expected: PASS

- [ ] **Step 5: Write the failing wiring tests**

Append to `dashboard/tests/message-images.test.tsx`:

```tsx
test('clicking a message image opens the lightbox', () => {
  render(<MessageImages sessionId="s1" messageId="m1" images={[PNG_A]} imageMeta={[META]} />);
  assert.equal(screen.queryByRole('dialog'), null);
  fireEvent.click(screen.getByLabelText('Enlarge attachment 1'));
  assert.notEqual(screen.queryByRole('dialog'), null);
});

test('clicking a pending image opens the lightbox', () => {
  render(<PendingImageStrip images={[{ dataUrl: PNG_A, note: null }]} pendingCount={0} onChange={() => undefined} />);
  fireEvent.click(screen.getByLabelText('Enlarge pending attachment 1'));
  assert.notEqual(screen.queryByRole('dialog'), null);
});

test('the pending strip shows a skeleton tile for each in-flight read', () => {
  render(<PendingImageStrip images={[]} pendingCount={2} onChange={() => undefined} />);
  assert.equal(screen.getAllByLabelText('Reading image').length, 2);
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `node .\dist\test-runner\run-tests.js message-images`
Expected: FAIL — no element labelled `Enlarge attachment 1`; `pendingCount` is not a known prop.

- [ ] **Step 7: Wire the lightbox into `MessageImages`**

In `dashboard/src/components/MessageImages.tsx`, add the import:

```tsx
import { ImageLightbox } from './ImageLightbox';
```

Add state next to `captionStates` (line 28):

```tsx
  const [zoomedIndex, setZoomedIndex] = useState<number | null>(null);
```

Replace the bare `<img …/>` inside the `<figure>` (lines 82-85):

```tsx
            <button
              type="button"
              className="image-zoom"
              aria-label={`Enlarge attachment ${index + 1}`}
              title="Enlarge"
              onClick={() => setZoomedIndex(index)}
            >
              <img
                src={image}
                alt={meta ? `Attachment ${index + 1}, ${meta.width} by ${meta.height}` : `Attachment ${index + 1}`}
              />
            </button>
```

Render the overlay immediately before the closing `</div>` of `.message-images` (after the `images.map(...)` block):

```tsx
      {zoomedIndex !== null && images[zoomedIndex] ? (
        <ImageLightbox
          src={images[zoomedIndex]}
          alt={`Attachment ${zoomedIndex + 1}`}
          onClose={() => setZoomedIndex(null)}
        />
      ) : null}
```

- [ ] **Step 8: Rewrite `PendingImageStrip`**

Replace `dashboard/src/components/PendingImageStrip.tsx` with:

```tsx
import React, { useState } from 'react';
import { ImageLightbox } from './ImageLightbox';
import type { PendingImage } from '../lib/downscale-image';

export function removePendingImage(images: PendingImage[], index: number): PendingImage[] {
  return images.filter((_, position) => position !== index);
}

export function PendingImageStrip({ images, pendingCount, onChange }: {
  images: PendingImage[];
  pendingCount: number;
  onChange(next: PendingImage[]): void;
}) {
  const [zoomedIndex, setZoomedIndex] = useState<number | null>(null);
  if (images.length === 0 && pendingCount === 0) {
    return null;
  }
  return (
    <div className="pending-images" role="list">
      {images.map((image, index) => (
        <div className="pending-image" role="listitem" key={`${index}:${image.dataUrl.slice(0, 32)}`}>
          <button
            type="button"
            className="image-zoom"
            aria-label={`Enlarge pending attachment ${index + 1}`}
            title="Enlarge"
            onClick={() => setZoomedIndex(index)}
          >
            <img src={image.dataUrl} alt={`Pending attachment ${index + 1}`} />
          </button>
          {image.note ? (
            <span className="pending-image-badge" title={image.note}>resized</span>
          ) : null}
          <button
            type="button"
            className="pending-image-remove"
            aria-label={`Remove image ${index + 1}`}
            title={`Remove image ${index + 1}`}
            onClick={() => onChange(removePendingImage(images, index))}
          >
            ×
          </button>
        </div>
      ))}
      {Array.from({ length: pendingCount }, (_, index) => (
        <div className="pending-image loading" role="listitem" aria-label="Reading image" key={`loading:${index}`}>
          <span className="sp" />
        </div>
      ))}
      {zoomedIndex !== null && images[zoomedIndex] ? (
        <ImageLightbox
          src={images[zoomedIndex].dataUrl}
          alt={`Pending attachment ${zoomedIndex + 1}`}
          onClose={() => setZoomedIndex(null)}
        />
      ) : null}
    </div>
  );
}
```

- [ ] **Step 9: Track in-flight reads in `ChatTab`**

In `dashboard/src/tabs/ChatTab.tsx`, add state next to `pendingImageReadState` (line 215):

```tsx
  const [pendingImageReadCount, setPendingImageReadCount] = React.useState(0);
```

Reset it in the session-change effect (lines 234-237) by adding `setPendingImageReadCount(0);` after the tail reset.

In `enqueuePendingImageRead` (the `File[]` version from Task 3), add the counter around the read:

```tsx
  function enqueuePendingImageRead(files: File[], maxPixels: number): void {
    if (files.length === 0) {
      return;
    }
    const generation = pendingImageReadState.current.generation;
    const sessionId = selectedSessionId;
    const fileCount = files.length;
    setPendingImageReadCount((previous) => previous + fileCount);
    const batch = readImageFiles(files, maxPixels);
    pendingImageReadState.current.tail = pendingImageReadState.current.tail.then(async () => {
      try {
        const images = await batch;
        if (generation === pendingImageReadState.current.generation) {
          onPendingImagesAppend(sessionId, images);
        }
      } catch (error) {
        if (generation === pendingImageReadState.current.generation) {
          onPendingImageError(sessionId, error instanceof Error ? error.message : String(error));
        }
      } finally {
        setPendingImageReadCount((previous) => Math.max(0, previous - fileCount));
      }
    });
  }
```

Pass the count to the strip (line 425):

```tsx
              <PendingImageStrip
                images={pendingImages}
                pendingCount={pendingImageReadCount}
                onChange={onPendingImagesChange}
              />
```

- [ ] **Step 10: Add the styles**

Append to `dashboard/src/styles/chat.css`:

```css
.image-zoom { border: none; background: none; padding: 0; cursor: zoom-in; display: block; line-height: 0; }
.image-lightbox { position: fixed; inset: 0; z-index: 60; background: rgba(4, 8, 12, 0.88); display: flex; align-items: center; justify-content: center; cursor: zoom-out; }
.image-lightbox img { max-width: 90vw; max-height: 90vh; object-fit: contain; cursor: default; }
.image-lightbox-close { position: absolute; top: 14px; right: 18px; font-size: 1.4rem; line-height: 1; color: var(--ink); background: none; border: none; cursor: pointer; }
.pending-image.loading { display: flex; align-items: center; justify-content: center; width: 56px; height: 56px; border: 1px dashed var(--line); border-radius: 6px; }
```

- [ ] **Step 11: Update existing `PendingImageStrip` render calls**

Add `pendingCount={0}` to every `<PendingImageStrip …/>` in `dashboard/tests/pending-image-strip.test.tsx` and `dashboard/tests/message-images.test.tsx`.

- [ ] **Step 12: Run the tests to verify they pass**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js message-images`, `node .\dist\test-runner\run-tests.js pending-image-strip`, `node .\dist\test-runner\run-tests.js chat-tab`
Expected: PASS

- [ ] **Step 13: Commit**

```bash
git add dashboard/src dashboard/tests dashboard/src/styles/chat.css
git commit -m "feat(chat): enlarge chat images in an inline lightbox and show attachment read progress"
```

---

## Task 5: Persist image metadata on user messages

**Files:**
- Modify: `src/status-server/chat.ts:413-437,476-490`
- Modify: `src/status-server/routes/chat.ts:223-233,691-700,785-809,898-909,973-977,1038-1053`
- Modify: `src/status-server/chat-repo-operation-runner.ts:136,193,243-282`
- Test: `tests/status-server-chat.test.ts`, `tests/status-server-chat-routes.test.ts`

- [ ] **Step 1: Write the failing unit test**

Append to `tests/status-server-chat.test.ts` (import `appendChatMessagesWithUsage` alongside `buildContextUsage`):

```ts
test('appendChatMessagesWithUsage persists image metadata on the user message', () => {
  const runtimeRoot = createManagedTempDir('siftkit-append-image-meta-');
  const session = createTestChatSession(runtimeRoot);
  const metadata = ImageMetadataSchema.parse({
    width: 32, height: 32, originalWidth: 32, originalHeight: 32,
    mime: 'image/png', byteLength: 64, tokenEstimate: 1024, resized: false, caption: null,
  });

  const updated = appendChatMessagesWithUsage(runtimeRoot, session, 'look', 'ok', {}, {
    turns: [{ thinkingText: '', toolMessages: [] }],
    images: ['data:image/png;base64,AA=='],
    imageMeta: [metadata],
  });

  const userMessage = updated.messages.find((message) => message.role === 'user');
  assert.deepEqual(userMessage?.imageMeta, [metadata]);
});
```

Add the imports this test needs to the top of the file:

```ts
import { ImageMetadataSchema } from '@siftkit/contracts';
import { createTestChatSession } from './helpers/chat-sessions.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
```

- [ ] **Step 2: Write the failing route test**

Append to `tests/status-server-chat-routes.test.ts`. The non-streaming message route is used deliberately: passing `assistantContent` takes the `runProvidedAssistantTurn` branch, so no engine is needed.

```ts
test('the message route persists admitted image metadata on the user message', async () => {
  const context = await withCaptionServer();
  try {
    const image = toDataUrl('image/png', rasterBuffer('png', 4, 4));
    const response = await requestJson(
      `${context.baseUrl}/dashboard/chat/sessions/${context.fixture.session.id}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({ content: 'what is this', images: [image], assistantContent: 'a tiny square' }),
      },
    );
    assert.equal(response.statusCode, 200);

    const stored = readChatSessionFromPath(
      getChatSessionPath(context.fixture.runtimeRoot, context.fixture.session.id),
    );
    const appendedUserMessage = stored?.messages?.filter((message) => message.role === 'user').at(-1);
    assert.equal(appendedUserMessage?.images?.length, 1);
    assert.equal(appendedUserMessage?.imageMeta?.length, 1);
    assert.ok((appendedUserMessage?.imageMeta?.[0]?.tokenEstimate ?? 0) > 0);
  } finally {
    await closeCaptionTestServer(context.server, context.previousCwd, context.envBackup, context.tempRoot);
  }
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js status-server-chat`
Expected: FAIL — `imageMeta` is not a known option; the persisted `imageMeta` is `undefined`.

- [ ] **Step 4: Keep the metadata at admission**

In `src/status-server/routes/chat.ts`, replace `admitSelectedChatImages` (lines 223-233):

```ts
function admitSelectedChatImages(
  config: SiftConfig,
  session: ChatSession,
  requestedImages: string[],
): { effectiveConfig: SiftConfig; images: string[]; imageMeta: ImageMetadata[] } {
  const effectiveConfig = resolveChatSessionConfig(config, session);
  const activePreset = getActiveModelPreset(effectiveConfig);
  const admitted = admitImagesForPreset(activePreset, requestedImages);
  return {
    effectiveConfig,
    images: admitted.map((image) => image.dataUrl),
    imageMeta: admitted.map((image) => image.metadata),
  };
}
```

Add the type import near the other contract imports:

```ts
import type { ImageMetadata } from '@siftkit/contracts';
```

- [ ] **Step 5: Accept and persist the metadata**

In `src/status-server/chat.ts`, add to `AppendChatOptions` after `images?: string[];` (line 436):

```ts
  imageMeta?: ImageMetadata[];
```

and set it on the user-message push (line 489):

```ts
    images: options.images ?? [],
    imageMeta: options.imageMeta ?? [],
```

`ImageMetadata` is already imported in this file (used at line 566).

- [ ] **Step 6: Thread it through the call sites**

`ChatMessageTurn` — add a constructor parameter after `userImages` (line 699):

```ts
    private readonly userImageMeta: ImageMetadata[],
```

and add it to the append options in `persistAndRespond` (line 807):

```ts
        images: this.userImages,
        imageMeta: this.userImageMeta,
```

Update the construction site (lines 899-909) to pass `selectedImages.imageMeta` immediately after `selectedImages.images`.

Repo-search stream endpoint — extend the append options (line 1053):

```ts
        images: selectedImages.images,
        imageMeta: selectedImages.imageMeta,
```

`src/status-server/chat-repo-operation-runner.ts` — replace line 136:

```ts
    const admitted = admitImagesForPreset(activePreset, request.images);
    const admittedImages = admitted.map((image) => image.dataUrl);
    const admittedImageMeta = admitted.map((image) => image.metadata);
```

pass `admittedImageMeta` alongside `admittedImages` at line 193, add `admittedImageMeta: ImageMetadata[];` to the `persistResult` options type (line 249), and extend the append options (line 281):

```ts
        images: options.admittedImages,
        imageMeta: options.admittedImageMeta,
```

Add the type import to that file:

```ts
import type { ImageMetadata } from '@siftkit/contracts';
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js status-server-chat`
Expected: PASS (both `status-server-chat` and `status-server-chat-routes` match this stem).

- [ ] **Step 8: Commit**

```bash
git add src/status-server tests/status-server-chat.test.ts tests/status-server-chat-routes.test.ts
git commit -m "feat(chat): persist admitted image metadata on user messages"
```

---

## Task 6: Count image tokens in context usage

**Files:**
- Modify: `packages/contracts/src/chat.ts:46-52`
- Modify: `src/status-server/chat.ts:44-56,87-95,153-195`
- Modify: `dashboard/src/tabs/ChatTab.tsx:483-534`
- Test: `tests/status-server-chat.test.ts` plus every `ContextUsage` fixture

- [ ] **Step 1: Write the failing test**

Append to `tests/status-server-chat.test.ts`:

```ts
test('buildContextUsage counts persisted image tokens', () => {
  const config = createConfig();
  const baseMessage = {
    id: 'u1',
    role: 'user' as const,
    kind: 'user_text' as const,
    content: 'look',
    inputTokensEstimate: 1,
    outputTokensEstimate: 0,
    thinkingTokens: 0,
    createdAtUtc: '2026-08-08T00:00:00.000Z',
  };
  const session = createSession();
  const withoutImages = buildContextUsage(config, mockChatSession({ ...session, messages: [baseMessage] }));
  const withImages = buildContextUsage(config, mockChatSession({
    ...session,
    messages: [{
      ...baseMessage,
      images: ['data:image/png;base64,AA=='],
      imageMeta: [ImageMetadataSchema.parse({
        width: 1024, height: 1024, originalWidth: 1024, originalHeight: 1024,
        mime: 'image/png', byteLength: 2048, tokenEstimate: 1024, resized: false, caption: null,
      })],
    }],
  }));

  assert.equal(withoutImages.imageUsedTokens, 0);
  assert.equal(withImages.imageUsedTokens, 1024);
  assert.equal(withImages.chatUsedTokens, withoutImages.chatUsedTokens + 1024);
  assert.equal(withImages.totalUsedTokens, withoutImages.totalUsedTokens + 1024);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js status-server-chat`
Expected: FAIL — `imageUsedTokens` does not exist on `ContextUsage`.

- [ ] **Step 3: Add the contract field**

In `packages/contracts/src/chat.ts`, add to `ContextUsageSchema` after `toolUsedTokens`:

```ts
  imageUsedTokens: z.number().int().nonnegative(),
```

- [ ] **Step 4: Count image tokens on the server**

In `src/status-server/chat.ts`, add a helper after `getMessageThinkingTokenEstimate` (line 56):

```ts
function getMessageImageTokenEstimate(message: PersistedChatMessage): number {
  const imageMeta = Array.isArray(message.imageMeta) ? message.imageMeta : [];
  return imageMeta.reduce((sum, metadata) => sum + metadata.tokenEstimate, 0);
}
```

Include it in `getMessageContextTokenEstimate` (lines 44-49):

```ts
function getMessageContextTokenEstimate(message: PersistedChatMessage): number {
  if (message.kind === 'assistant_thinking') {
    return estimateTokenCount(message.content);
  }
  return estimateTokenCount(formatChatMessageForPrompt(message))
    + getMessageThinkingTokenEstimate(message)
    + getMessageImageTokenEstimate(message);
}
```

Add `imageUsedTokens: number;` to `ContextUsageTokenTotals` (lines 87-95).

In `buildTokenTotals` (line 177), add the reduce next to the others and return it:

```ts
    const imageUsedTokens = messages.reduce((sum: number, message: PersistedChatMessage) => sum + getMessageImageTokenEstimate(message), 0);
```

In `build()` (line 158), add after `toolUsedTokens`:

```ts
      imageUsedTokens: totals.imageUsedTokens,
```

- [ ] **Step 5: Show it in the settings popover**

In `dashboard/src/tabs/ChatTab.tsx` `SettingsPopover`, add after the thinking/reasoning span (line 522):

```tsx
          <span title="Estimated tokens consumed by images attached in this session.">
            Images: {formatNumber(contextUsage.imageUsedTokens)}
          </span>
```

- [ ] **Step 6: Update every `ContextUsage` fixture**

Add `imageUsedTokens: 0,` to each literal fixture. Files (find with `grep estimatedTokenFallbackTokens`):
`dashboard/tests/chat-tab.test.tsx:56-61`, `dashboard/tests/hooks/useChatSessions.test.tsx`,
`dashboard/tests/chat-session-runtime-store.test.ts:21-33`, `dashboard/tests/api-stream.test.ts`,
`dashboard/tests/chat-stream-transitions.test.ts`, `dashboard/tests/chat-stream-parser.test.ts`,
`dashboard/tests/lib/contextBar.test.ts`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js status-server-chat` and `npm run test:dashboard`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/contracts/src/chat.ts src/status-server/chat.ts dashboard/src/tabs/ChatTab.tsx dashboard/tests tests
git commit -m "feat(chat): count attached image tokens in session context usage"
```

---

## Task 7: `deleteChatMessageImage` in the state layer

**Files:**
- Modify: `src/state/chat-sessions.ts:150-155,458-512`
- Test: `tests/status-server-chat-routes.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/status-server-chat-routes.test.ts` (next to the existing caption-persistence tests, reusing their helpers):

```ts
test('deleteChatMessageImage strips one image and marks the message', () => {
  const runtimeRoot = createManagedTempDir('siftkit-delete-image-db-');
  const session = createTestChatSession(runtimeRoot);
  const message = {
    id: 'two-images',
    role: 'user' as const,
    kind: 'user_text' as const,
    content: 'compare these',
    inputTokensEstimate: 1,
    outputTokensEstimate: 1,
    thinkingTokens: 0,
    createdAtUtc: '2026-08-08T00:00:00.000Z',
    images: ['data:image/png;base64,AA==', 'data:image/png;base64,BB=='],
    imageMeta: [imageMetadata(), imageMetadata(2, 2, 'keep me')],
  };
  saveChatSession(runtimeRoot, { ...session, messages: [message] });

  deleteChatMessageImage(runtimeRoot, session.id, message.id, 0);

  const reloaded = readChatSessionFromPath(getChatSessionPath(runtimeRoot, session.id));
  assert.deepEqual(reloaded?.messages?.[0]?.images, ['data:image/png;base64,BB==']);
  assert.equal(reloaded?.messages?.[0]?.imageMeta?.length, 1);
  assert.equal(reloaded?.messages?.[0]?.imageMeta?.[0]?.caption, 'keep me');
  assert.match(String(reloaded?.messages?.[0]?.content), /compare these\n\[image removed\]/u);
});

test('deleteChatMessageImage rejects missing targets and invalid boundaries', () => {
  const runtimeRoot = createManagedTempDir('siftkit-delete-image-boundaries-');
  const session = createTestChatSession(runtimeRoot);
  const message = {
    id: 'one-image',
    role: 'user' as const,
    kind: 'user_text' as const,
    content: 'one image',
    inputTokensEstimate: 1,
    outputTokensEstimate: 1,
    thinkingTokens: 0,
    createdAtUtc: '2026-08-08T00:00:00.000Z',
    images: ['data:image/png;base64,AA=='],
    imageMeta: [imageMetadata()],
  };
  saveChatSession(runtimeRoot, { ...session, messages: [message] });

  assert.throws(
    () => deleteChatMessageImage(runtimeRoot, session.id, 'missing', 0),
    ChatMessageImageNotFoundError,
  );
  assert.throws(
    () => deleteChatMessageImage(runtimeRoot, session.id, message.id, 7),
    ChatMessageImageNotFoundError,
  );
  assert.throws(
    () => deleteChatMessageImage(runtimeRoot, session.id, message.id, -1),
    /non-negative integer/u,
  );
});

test('deleteChatMessageImage does not duplicate the removed marker', () => {
  const runtimeRoot = createManagedTempDir('siftkit-delete-image-marker-');
  const session = createTestChatSession(runtimeRoot);
  const message = {
    id: 'two-images-marker',
    role: 'user' as const,
    kind: 'user_text' as const,
    content: 'compare these',
    inputTokensEstimate: 1,
    outputTokensEstimate: 1,
    thinkingTokens: 0,
    createdAtUtc: '2026-08-08T00:00:00.000Z',
    images: ['data:image/png;base64,AA==', 'data:image/png;base64,BB=='],
    imageMeta: [imageMetadata(), imageMetadata()],
  };
  saveChatSession(runtimeRoot, { ...session, messages: [message] });

  deleteChatMessageImage(runtimeRoot, session.id, message.id, 0);
  deleteChatMessageImage(runtimeRoot, session.id, message.id, 0);

  const reloaded = readChatSessionFromPath(getChatSessionPath(runtimeRoot, session.id));
  assert.deepEqual(reloaded?.messages?.[0]?.images, []);
  assert.equal((String(reloaded?.messages?.[0]?.content).match(/\[image removed\]/gu) ?? []).length, 1);
});
```

Add `deleteChatMessageImage` to the existing import from `../src/state/chat-sessions.js` at the top of the file.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js status-server-chat-routes`
Expected: FAIL — `deleteChatMessageImage` is not exported.

- [ ] **Step 3: Implement it**

In `src/state/chat-sessions.ts`, add the row schema next to `MessageImageRowSchema` (line 150-155):

```ts
const MessageImageContentRowSchema = MessageImageRowSchema.extend({
  content: z.string(),
});
```

Add the following directly after `updateChatMessageImageCaption` (line 512):

```ts
const IMAGE_REMOVED_MARKER = '[image removed]';

function touchChatSession(runtimeRoot: string, sessionId: string): void {
  getSessionDatabase(runtimeRoot)
    .prepare('UPDATE chat_sessions SET updated_at_utc = ? WHERE id = ?')
    .run(new Date().toISOString(), sessionId);
}

/**
 * Drops one attachment from a persisted message so its tokens stop replaying into every
 * later request. The marker keeps the turn readable: without it a message that referred
 * to "this screenshot" would dangle.
 */
export function deleteChatMessageImage(
  runtimeRoot: string,
  sessionId: string,
  messageId: string,
  imageIndex: number,
): void {
  const normalizedSessionId = sessionId.trim();
  const normalizedMessageId = messageId.trim();
  if (!normalizedSessionId || !normalizedMessageId) {
    throw new Error('Session id and message id are required.');
  }
  if (!Number.isInteger(imageIndex) || imageIndex < 0) {
    throw new Error('Image index must be a non-negative integer.');
  }

  const database = getSessionDatabase(runtimeRoot);
  const rowValue = database.prepare(`
    SELECT id, images, image_meta, content
    FROM chat_messages
    WHERE session_id = ? AND id = ?
  `).get(normalizedSessionId, normalizedMessageId);
  if (rowValue === undefined || rowValue === null) {
    throw new ChatMessageImageNotFoundError();
  }
  const row = MessageImageContentRowSchema.parse(rowValue);
  const images = row.images === null ? [] : parseImageDataUrls(parseJsonValueText(row.images));
  if (!images[imageIndex]) {
    throw new ChatMessageImageNotFoundError();
  }
  const imageMeta = row.image_meta === null
    ? []
    : z.array(ImageMetadataSchema).parse(parseJsonValueText(row.image_meta));
  const remainingImages = images.filter((_, index) => index !== imageIndex);
  const remainingImageMeta = imageMeta.filter((_, index) => index !== imageIndex);
  const content = row.content.includes(IMAGE_REMOVED_MARKER)
    ? row.content
    : `${row.content}\n${IMAGE_REMOVED_MARKER}`.trim();
  const result = database.prepare(`
    UPDATE chat_messages
    SET images = ?, image_meta = ?, content = ?
    WHERE session_id = ? AND id = ?
  `).run(
    JSON.stringify(remainingImages),
    remainingImageMeta.length > 0 ? JSON.stringify(remainingImageMeta) : null,
    content,
    normalizedSessionId,
    normalizedMessageId,
  );
  if (Number(result.changes || 0) !== 1) {
    throw new ChatMessageImageNotFoundError();
  }
  touchChatSession(runtimeRoot, normalizedSessionId);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js status-server-chat-routes`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/state/chat-sessions.ts tests/status-server-chat-routes.test.ts
git commit -m "feat(chat): add per-image deletion to the chat session store"
```

---

## Task 8: `DELETE …/messages/:id/images/:index` endpoint

**Files:**
- Modify: `src/status-server/routes/chat.ts:560-590,1374-1389`
- Test: `tests/status-server-chat-routes.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/status-server-chat-routes.test.ts`. `withCaptionServer()` seeds `caption-message` with exactly one image and its metadata.

```ts
test('deleting one image returns the session with reduced context usage', async () => {
  const context = await withCaptionServer();
  try {
    const before = await requestJson(
      `${context.baseUrl}/dashboard/chat/sessions/${context.fixture.session.id}`,
    );
    assert.equal(before.statusCode, 200);
    assert.ok(Number(asObject(before.body.contextUsage).imageUsedTokens) > 0);

    const response = await requestJson(
      `${context.baseUrl}/dashboard/chat/sessions/${context.fixture.session.id}/messages/${context.fixture.message.id}/images/0`,
      { method: 'DELETE' },
    );

    assert.equal(response.statusCode, 200);
    assert.equal(Number(asObject(response.body.contextUsage).imageUsedTokens), 0);

    const stored = readChatSessionFromPath(
      getChatSessionPath(context.fixture.runtimeRoot, context.fixture.session.id),
    );
    assert.deepEqual(stored?.messages?.[0]?.images, []);
    assert.match(String(stored?.messages?.[0]?.content), /\[image removed\]/u);
  } finally {
    await closeCaptionTestServer(context.server, context.previousCwd, context.envBackup, context.tempRoot);
  }
});

test('deleting an out-of-range image index answers 404', async () => {
  const context = await withCaptionServer();
  try {
    const response = await requestJson(
      `${context.baseUrl}/dashboard/chat/sessions/${context.fixture.session.id}/messages/${context.fixture.message.id}/images/7`,
      { method: 'DELETE' },
    );
    assert.equal(response.statusCode, 404);
  } finally {
    await closeCaptionTestServer(context.server, context.previousCwd, context.envBackup, context.tempRoot);
  }
});

test('deleting an image on an unknown message answers 404', async () => {
  const context = await withCaptionServer();
  try {
    const response = await requestJson(
      `${context.baseUrl}/dashboard/chat/sessions/${context.fixture.session.id}/messages/no-such-message/images/0`,
      { method: 'DELETE' },
    );
    assert.equal(response.statusCode, 404);
  } finally {
    await closeCaptionTestServer(context.server, context.previousCwd, context.envBackup, context.tempRoot);
  }
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js status-server-chat-routes`
Expected: FAIL — the route is unregistered, so the first test's DELETE does not return a session response.

- [ ] **Step 3: Add the endpoint**

In `src/status-server/routes/chat.ts`, after `DeleteChatMessageEndpoint` (line 590):

```ts
class DeleteChatMessageImageEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    routeMatch: RouteMatch,
  ): Promise<void> {
    const { configPath } = ctx;
    const runtimeRoot = getRuntimeRoot();
    const match = /^\/dashboard\/chat\/sessions\/([^/]+)\/messages\/([^/]+)\/images\/([0-9]+)$/u
      .exec(routeMatch.pathname);
    const sessionId = decodeURIComponent(match?.[1] || '');
    const messageId = decodeURIComponent(match?.[2] || '');
    const imageIndex = Number(match?.[3]);
    try {
      deleteChatMessageImage(runtimeRoot, sessionId, messageId, imageIndex);
    } catch (error) {
      if (error instanceof ChatMessageImageNotFoundError) {
        sendJson(res, 404, { error: 'Image not found.' });
        return;
      }
      throw error;
    }
    const session = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
    if (!session) {
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    sendJson(res, 200, buildChatSessionResponse(readConfig(configPath), session));
  }
}
```

Add `deleteChatMessageImage` and `ChatMessageImageNotFoundError` to the existing import from `../../state/chat-sessions.js`.

Register the route in `CHAT_ROUTES`, immediately **before** the plain message-delete entry (line 1379) so the more specific pattern matches first:

```ts
  { method: 'DELETE', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/messages\/([^/]+)\/images\/([0-9]+)$/u, endpoint: new DeleteChatMessageImageEndpoint() },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js status-server-chat-routes`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/status-server/routes/chat.ts tests/status-server-chat-routes.test.ts
git commit -m "feat(chat): add a per-image delete route"
```

---

## Task 9: Delete an image from a chat bubble

**Files:**
- Modify: `dashboard/src/api.ts:370-374`
- Modify: `dashboard/src/hooks/useChatSessions.ts:294-312,417-443`
- Modify: `dashboard/src/hooks/useChatController.ts:77-83,113-115`
- Modify: `dashboard/src/tabs/ChatTab.tsx:89-123,181-214,350-377,599-619,621-638,680-706`
- Modify: `dashboard/src/components/MessageImages.tsx:22-107`
- Modify: `dashboard/src/styles/chat.css`
- Test: `dashboard/tests/message-images.test.tsx`, `dashboard/tests/chat-tab.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append to `dashboard/tests/message-images.test.tsx`:

```tsx
test('the per-image delete button reports the image index', () => {
  const deleted: number[] = [];
  render(
    <MessageImages
      sessionId="s1"
      messageId="m1"
      images={[PNG_A, PNG_B]}
      imageMeta={[META, META]}
      chatBusy={false}
      onDeleteImage={async (index: number) => { deleted.push(index); }}
    />,
  );
  fireEvent.click(screen.getByLabelText('Delete image 2'));
  assert.deepEqual(deleted, [1]);
});

test('the per-image delete button is disabled while the session is busy', () => {
  render(
    <MessageImages
      sessionId="s1"
      messageId="m1"
      images={[PNG_A]}
      imageMeta={[META]}
      chatBusy
      onDeleteImage={async () => undefined}
    />,
  );
  assert.equal(screen.getByLabelText('Delete image 1').hasAttribute('disabled'), true);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js message-images`
Expected: FAIL — no element labelled `Delete image 2`; `chatBusy`/`onDeleteImage` are unknown props.

- [ ] **Step 3: Add the API client function**

In `dashboard/src/api.ts`, after `deleteChatMessage` (line 374):

```ts
export function deleteChatMessageImage(
  sessionId: string,
  messageId: string,
  imageIndex: number,
): Promise<ChatSessionResponse> {
  return fetchJson(
    `/dashboard/chat/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/images/${imageIndex}`,
    ChatSessionResponseSchema,
    { method: 'DELETE' },
  );
}
```

- [ ] **Step 4: Add the hook action**

In `dashboard/src/hooks/useChatSessions.ts`, add `deleteChatMessageImage` to the existing `../api` import, then add after `deleteMessages` (line 312):

```ts
  async function deleteMessageImage(messageId: string, imageIndex: number): Promise<ChatSessionResponse | null> {
    if (!selectedSessionId || !messageId) {
      return null;
    }
    try {
      const response = await deleteChatMessageImage(selectedSessionId, messageId, imageIndex);
      applySessionResponse(response);
      return response;
    } catch (error) {
      recordSessionError(selectedSessionId, toError(error));
      return null;
    }
  }
```

Add `deleteMessageImage,` to the returned object next to `deleteMessages` (line 432).

- [ ] **Step 5: Wire the controller**

In `dashboard/src/hooks/useChatController.ts`, after `onDeleteChatTurn` (line 83):

```ts
  async function onDeleteChatMessageImage(messageId: string, imageIndex: number): Promise<void> {
    const response = await chatSessionsHook.deleteMessageImage(messageId, imageIndex);
    if (!response) {
      return;
    }
    await refreshAfterChatMessageMutation();
  }
```

and add to `tabProps` after `onDeleteTurn` (line 114):

```ts
    onDeleteMessageImage: onDeleteChatMessageImage,
```

- [ ] **Step 6: Thread the prop through `ChatTab`**

In `dashboard/src/tabs/ChatTab.tsx`, add to `ChatTabProps` after `onDeleteTurn` (line 115):

```ts
  onDeleteMessageImage(messageId: string, imageIndex: number): Promise<void>;
```

Destructure `onDeleteMessageImage` in the component signature, then replace `renderMessageBody` (lines 599-619):

```tsx
function renderMessageBody(
  message: ChatMessage,
  sessionId: string,
  isDirectChatMode: boolean,
  isLive: boolean,
  chatBusy: boolean,
  onDeleteMessageImage: (messageId: string, imageIndex: number) => Promise<void>,
) {
  const messageKind = normalizeMessageKind(message);
  const images = (
    <MessageImages
      key={`${sessionId}:${message.id}`}
      sessionId={sessionId}
      messageId={message.id}
      images={message.images ?? []}
      imageMeta={message.imageMeta ?? []}
      chatBusy={chatBusy || isLive}
      onDeleteImage={(imageIndex: number) => onDeleteMessageImage(message.id, imageIndex)}
    />
  );
  if (messageKind === 'tool_image') {
    return images;
  }
  if (messageKind === 'assistant_tool_call') {
    return <ToolCallCard message={message} />;
  }
  if (messageKind === 'assistant_thinking') {
    return <ThinkingBody message={message} isLive={isLive} />;
  }
  if (message.role === 'assistant') {
    return <AssistantAnswerBody message={message} isLive={isLive} isDirectChatMode={isDirectChatMode} />;
  }
  return (
    <>
      <p className="user-message">{message.content}</p>
      {images}
    </>
  );
}
```

Add `onDeleteMessageImage` to `MessageBubble`'s props and forward both new arguments:

```tsx
      {renderMessageBody(message, sessionId, isDirectChatMode, isLive, chatBusy, onDeleteMessageImage)}
```

Add `onDeleteMessageImage` to `ChatTurnBubble`'s props and pass it at all three `MessageBubble` call sites (lines 355, 684, 697) and at the `ChatTurnBubble` call site (line 367).

- [ ] **Step 7: Render the delete button**

In `dashboard/src/components/MessageImages.tsx`, extend the props:

```tsx
export function MessageImages({ sessionId, messageId, images, imageMeta, chatBusy, onDeleteImage }: {
  sessionId: string;
  messageId: string;
  images: string[];
  imageMeta: ImageMetadata[];
  chatBusy: boolean;
  onDeleteImage(imageIndex: number): Promise<void>;
}) {
```

and add the button inside the `<figure>`, directly after the zoom button:

```tsx
            <button
              type="button"
              className="msg-icon-button danger message-image-remove"
              aria-label={`Delete image ${index + 1}`}
              title="Delete this image and free its context tokens"
              disabled={chatBusy}
              onClick={() => { void onDeleteImage(index); }}
            >
              &#128465;
            </button>
```

- [ ] **Step 8: Update the Task 4 lightbox test call and other render sites**

Add `chatBusy={false}` and `onDeleteImage={async () => undefined}` to every `<MessageImages …/>` in `dashboard/tests/message-images.test.tsx` (including `renderImages`) and `dashboard/tests/message-images-lifecycle.test.tsx`.

- [ ] **Step 9: Add the style**

Append to `dashboard/src/styles/chat.css`:

```css
.message-image { position: relative; }
.message-image-remove { position: absolute; top: 4px; right: 4px; background: rgba(4, 8, 12, 0.72); border-radius: 4px; padding: 2px 4px; }
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js message-images` and `node .\dist\test-runner\run-tests.js chat-tab`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add dashboard/src dashboard/tests
git commit -m "feat(chat): delete a single image from a chat bubble to free its context"
```

---

## Task 10: Show image tokens on the bubble token chip

**Files:**
- Modify: `dashboard/src/lib/format.ts:99-101`
- Modify: `dashboard/src/tabs/ChatTab.tsx:53-71,536-568`
- Test: `dashboard/tests/lib/format.test.ts` (create if absent), `dashboard/tests/chat-tab.test.tsx`

- [ ] **Step 1: Write the failing tests**

In `dashboard/tests/lib/format.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { getMessageImageTokenCount } from '../../src/lib/format';
import type { ChatMessage } from '../../src/types';

const BASE_MESSAGE: ChatMessage = {
  id: 'm1', role: 'user', kind: 'user_text', content: 'look',
  inputTokensEstimate: 12, outputTokensEstimate: 0, thinkingTokens: 0,
  createdAtUtc: '2026-08-08T00:00:00.000Z', sourceRunId: null,
};

const META = {
  width: 32, height: 32, originalWidth: 32, originalHeight: 32,
  mime: 'image/png' as const, byteLength: 64, tokenEstimate: 1024,
  resized: false, caption: null,
};

test('getMessageImageTokenCount sums persisted image estimates', () => {
  assert.equal(
    getMessageImageTokenCount({ ...BASE_MESSAGE, imageMeta: [META, { ...META, tokenEstimate: 512 }] }),
    1536,
  );
});

test('getMessageImageTokenCount is zero without images', () => {
  assert.equal(getMessageImageTokenCount(BASE_MESSAGE), 0);
});
```

In `dashboard/tests/chat-tab.test.tsx`:

```tsx
test('a bubble token chip separates text tokens from image tokens', () => {
  const session = {
    ...SESSION_A,
    messages: [msg({
      id: 'u1', role: 'user', kind: 'user_text', content: 'look',
      inputTokensEstimate: 12, inputTokensEstimated: false,
      images: [IMAGE], imageMeta: [{ ...IMAGE_META, tokenEstimate: 1024 }],
    })],
  };
  const markup = render({ selectedSession: session });

  assert.match(markup, /12 tokens \(\+1,024 img\)/u);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js format` and `node .\dist\test-runner\run-tests.js chat-tab`
Expected: FAIL — `getMessageImageTokenCount` is not exported; the chip shows `12 tokens`.

- [ ] **Step 3: Add the selector**

In `dashboard/src/lib/format.ts`, after `getReplayDisplayTokenCount` (line 101):

```ts
export function getMessageImageTokenCount(message: ChatSession['messages'][number]): number {
  const imageMeta = Array.isArray(message.imageMeta) ? message.imageMeta : [];
  return imageMeta.reduce((sum, metadata) => sum + metadata.tokenEstimate, 0);
}
```

- [ ] **Step 4: Render it**

In `dashboard/src/tabs/ChatTab.tsx`, add `getMessageImageTokenCount` to the `../lib/format` import, then add a formatter after `getTurnTokenDisplay` (line 71):

```tsx
function formatBubbleTokenLabel(message: ChatMessage): string {
  const textLabel = formatTokenLabel(getReplayDisplayTokenCount(message));
  const imageTokens = getMessageImageTokenCount(message);
  return imageTokens > 0 ? `${textLabel} (+${formatNumber(imageTokens)} img)` : textLabel;
}
```

Use it in `MessageHeader` (line 552):

```tsx
        <span className="msg-tokens" title="Text tokens, plus the estimated image tokens this message keeps in context.">{formatBubbleTokenLabel(message)}</span>
```

Include image tokens in the turn aggregate — replace the loop body in `getTurnTokenDisplay` (lines 57-66):

```tsx
  for (const message of messages) {
    const imageTokens = getMessageImageTokenCount(message);
    const tokenCount = getMessageTokenCount(message);
    if (tokenCount === null) {
      hasUnavailableComponent = true;
      knownTotal += getMessageKnownTokenCount(message) + imageTokens;
    } else {
      total += tokenCount + imageTokens;
      knownTotal += tokenCount + imageTokens;
    }
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js format` and `node .\dist\test-runner\run-tests.js chat-tab`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/lib/format.ts dashboard/src/tabs/ChatTab.tsx dashboard/tests
git commit -m "feat(chat): show image token cost on chat bubble token chips"
```

---

## Task 11: Last-turn telemetry selector

**Files:**
- Modify: `dashboard/src/lib/format.ts:235`
- Test: `dashboard/tests/lib/format.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `dashboard/tests/lib/format.test.ts`:

```ts
import { getLastTurnTelemetry } from '../../src/lib/format';
import type { ChatSession } from '../../src/types';

const SESSION_SHELL = {
  id: 's1', title: 'S', model: 'test-model', contextWindowTokens: 100,
  thinkingEnabled: true, presetId: 'chat-default', mode: 'chat', condensedSummary: '',
  createdAtUtc: '2026-08-08T00:00:00.000Z', updatedAtUtc: '2026-08-08T00:00:00.000Z',
};

const ASSISTANT_TURN = {
  ...BASE_MESSAGE,
  id: 'a1',
  role: 'assistant' as const,
  kind: 'assistant_answer' as const,
  content: 'done',
  promptEvalDurationMs: 1000,
  promptTokensPerSecond: 2048,
  generationTokensPerSecond: 32,
};

function sessionWith(messages: ChatSession['messages']): ChatSession {
  return { ...SESSION_SHELL, messages };
}

test('getLastTurnTelemetry reads the newest assistant turn', () => {
  const stats = getLastTurnTelemetry(sessionWith([
    { ...ASSISTANT_TURN, id: 'old', promptTokensPerSecond: 100, generationTokensPerSecond: 10 },
    ASSISTANT_TURN,
  ]));
  assert.equal(stats.promptTokensPerSecond, 2048);
  assert.equal(stats.generationTokensPerSecond, 32);
  assert.equal(stats.ttftMs, 1000);
});

test('getLastTurnTelemetry skips assistant turns that carry no timings', () => {
  const stats = getLastTurnTelemetry(sessionWith([
    ASSISTANT_TURN,
    { ...BASE_MESSAGE, id: 'a2', role: 'assistant', kind: 'assistant_answer', content: 'later' },
  ]));
  assert.equal(stats.promptTokensPerSecond, 2048);
});

test('getLastTurnTelemetry returns nulls when nothing has timings', () => {
  assert.deepEqual(getLastTurnTelemetry(sessionWith([BASE_MESSAGE])), {
    promptTokensPerSecond: null,
    generationTokensPerSecond: null,
    ttftMs: null,
  });
});

test('getLastTurnTelemetry returns nulls for a missing session', () => {
  assert.deepEqual(getLastTurnTelemetry(null), {
    promptTokensPerSecond: null,
    generationTokensPerSecond: null,
    ttftMs: null,
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js format`
Expected: FAIL — `getLastTurnTelemetry` is not exported.

- [ ] **Step 3: Implement it**

In `dashboard/src/lib/format.ts`, after `getSessionTelemetryStats` (line 235):

```ts
export type LastTurnTelemetry = {
  promptTokensPerSecond: number | null;
  generationTokensPerSecond: number | null;
  ttftMs: number | null;
};

function readPositiveTokenRate(value: OptionalJsonValue): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : null;
}

/**
 * The HUD reports the newest completed turn, not the running average, so a slow prompt
 * shows up the moment it happens. Rates only ride the terminal `done` payload, so this
 * never sees an in-flight turn.
 */
export function getLastTurnTelemetry(session: ChatSession | null): LastTurnTelemetry {
  const empty: LastTurnTelemetry = {
    promptTokensPerSecond: null,
    generationTokensPerSecond: null,
    ttftMs: null,
  };
  if (!session || !Array.isArray(session.messages)) {
    return empty;
  }
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (!message || message.role !== 'assistant') {
      continue;
    }
    const promptTokensPerSecond = readPositiveTokenRate(message.promptTokensPerSecond);
    const generationTokensPerSecond = readPositiveTokenRate(message.generationTokensPerSecond);
    const ttftMs = readPositiveTokenRate(message.promptEvalDurationMs);
    if (promptTokensPerSecond === null && generationTokensPerSecond === null && ttftMs === null) {
      continue;
    }
    return { promptTokensPerSecond, generationTokensPerSecond, ttftMs };
  }
  return empty;
}
```

`OptionalJsonValue` is already imported at the top of the file (line 3).

- [ ] **Step 4: Run them to verify they pass**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js format`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/lib/format.ts dashboard/tests/lib/format.test.ts
git commit -m "feat(chat): add a last-turn telemetry selector"
```

---

## Task 12: Performance HUD under the composer

**Files:**
- Create: `dashboard/src/components/ChatStatsBar.tsx`
- Create: `dashboard/tests/chat-stats-bar.test.tsx`
- Modify: `dashboard/src/tabs/ChatTab.tsx:73-95,181-214,464-473`
- Modify: `dashboard/src/hooks/useChatController.ts:3,46,85-92`
- Modify: `dashboard/src/styles/chat.css`
- Test: `dashboard/tests/chat-tab.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `dashboard/tests/chat-stats-bar.test.tsx`:

```tsx
import './react-test-environment.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ChatStatsBar } from '../src/components/ChatStatsBar';

const EMPTY_SESSION_STATS = {
  cacheHitRate: null,
  promptCacheTokens: 0,
  promptEvalTokens: 0,
  acceptanceRate: null,
  speculativeAcceptedTokens: 0,
  speculativeGeneratedTokens: 0,
  promptTokensPerSecond: null,
  generationTokensPerSecond: null,
};

const EMPTY_LAST_TURN = {
  promptTokensPerSecond: null,
  generationTokensPerSecond: null,
  ttftMs: null,
};

test('renders placeholders when no telemetry exists yet', () => {
  const markup = renderToStaticMarkup(
    <ChatStatsBar
      lastTurn={EMPTY_LAST_TURN}
      sessionStats={EMPTY_SESSION_STATS}
      contextUsage={null}
      streaming={false}
    />,
  );
  assert.match(markup, /class="chat-stats"/u);
  assert.equal((markup.match(/—/gu) ?? []).length, 6);
});

test('renders last-turn rates, session aggregates, and hover explanations', () => {
  const markup = renderToStaticMarkup(
    <ChatStatsBar
      lastTurn={{ promptTokensPerSecond: 1204, generationTokensPerSecond: 38.4, ttftMs: 210 }}
      sessionStats={{ ...EMPTY_SESSION_STATS, cacheHitRate: 0.87, acceptanceRate: 0.62, promptTokensPerSecond: 980 }}
      contextUsage={{
        contextWindowTokens: 40000,
        usedTokens: 14200,
        chatUsedTokens: 14200,
        thinkingUsedTokens: 0,
        toolUsedTokens: 0,
        imageUsedTokens: 0,
        totalUsedTokens: 14200,
        remainingTokens: 25800,
        warnThresholdTokens: 5000,
        shouldCondense: false,
        estimatedTokenFallbackTokens: 0,
        providerOverheadTokens: 0,
      }}
      streaming={false}
    />,
  );
  assert.match(markup, /1,204 t\/s/u);
  assert.match(markup, /38.4 t\/s/u);
  assert.match(markup, /210 ms/u);
  assert.match(markup, /87%/u);
  assert.match(markup, /62%/u);
  assert.match(markup, /14,200/u);
  assert.match(markup, /Session average: 980 t\/s/u);
  assert.match(markup, /Time to first token/u);
});

test('marks the strip as streaming while a turn is in flight', () => {
  const markup = renderToStaticMarkup(
    <ChatStatsBar
      lastTurn={EMPTY_LAST_TURN}
      sessionStats={EMPTY_SESSION_STATS}
      contextUsage={null}
      streaming
    />,
  );
  assert.match(markup, /class="chat-stats streaming"/u);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js chat-stats-bar`
Expected: FAIL — `Cannot find module '../src/components/ChatStatsBar'`.

- [ ] **Step 3: Write the component**

Create `dashboard/src/components/ChatStatsBar.tsx`:

```tsx
import React from 'react';

import { formatNumber } from '../lib/format';
import type { LastTurnTelemetry } from '../lib/format';
import type { ContextUsage } from '../types';

export type ChatSessionStats = {
  cacheHitRate: number | null;
  promptCacheTokens: number;
  promptEvalTokens: number;
  acceptanceRate: number | null;
  speculativeAcceptedTokens: number;
  speculativeGeneratedTokens: number;
  promptTokensPerSecond: number | null;
  generationTokensPerSecond: number | null;
};

const PLACEHOLDER = '—';

function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

function formatRate(value: number | null): string {
  return value === null ? PLACEHOLDER : `${formatNumber(roundToTenth(value))} t/s`;
}

function formatMs(value: number | null): string {
  return value === null ? PLACEHOLDER : `${formatNumber(Math.round(value))} ms`;
}

function formatPercent(value: number | null): string {
  return value === null ? PLACEHOLDER : `${Math.round(value * 100)}%`;
}

function formatSessionRate(value: number | null): string {
  return value === null ? 'not measured yet' : `${formatNumber(roundToTenth(value))} t/s`;
}

function StatChip({ icon, value, tip }: { icon: string; value: string; tip: string }) {
  return (
    <span className="chat-stat" data-tip={tip} title={tip}>
      <span className="chat-stat-icon" aria-hidden="true">{icon}</span>
      <span className="chat-stat-value">{value}</span>
    </span>
  );
}

export function ChatStatsBar({ lastTurn, sessionStats, contextUsage, streaming }: {
  lastTurn: LastTurnTelemetry;
  sessionStats: ChatSessionStats;
  contextUsage: ContextUsage | null;
  streaming: boolean;
}) {
  return (
    <div className={streaming ? 'chat-stats streaming' : 'chat-stats'} role="status" aria-label="Inference performance">
      <StatChip
        icon="⚡"
        value={formatRate(lastTurn.promptTokensPerSecond)}
        tip={`Prompt processing speed on the last completed turn. Session average: ${formatSessionRate(sessionStats.promptTokensPerSecond)}.`}
      />
      <StatChip
        icon="▸"
        value={formatRate(lastTurn.generationTokensPerSecond)}
        tip={`Token generation speed on the last completed turn. Session average: ${formatSessionRate(sessionStats.generationTokensPerSecond)}.`}
      />
      <StatChip
        icon="⏱"
        value={formatMs(lastTurn.ttftMs)}
        tip="Time to first token — the prompt-eval duration the backend reported for the last completed turn."
      />
      <StatChip
        icon="⛁"
        value={formatPercent(sessionStats.cacheHitRate)}
        tip={`Share of prompt tokens served from the prompt cache across this session (${formatNumber(sessionStats.promptCacheTokens)} cached of ${formatNumber(sessionStats.promptCacheTokens + sessionStats.promptEvalTokens)}).`}
      />
      <StatChip
        icon="✦"
        value={formatPercent(sessionStats.acceptanceRate)}
        tip="Speculative-decoding acceptance rate across this session. Higher means the draft model is guessing well."
      />
      <StatChip
        icon="Σ"
        value={contextUsage === null ? PLACEHOLDER : formatNumber(contextUsage.totalUsedTokens)}
        tip="Tokens currently occupying the context window, including attached images and tool output."
      />
    </div>
  );
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js chat-stats-bar`
Expected: PASS

- [ ] **Step 5: Mount it in the composer**

In `dashboard/src/tabs/ChatTab.tsx`:

Delete the local `SessionPromptCacheStats` type (lines 73-82) and import the owning type instead:

```tsx
import { ChatStatsBar, type ChatSessionStats } from '../components/ChatStatsBar';
import type { LastTurnTelemetry } from '../lib/format';
```

Change the prop declaration (line 95) to:

```tsx
  sessionPromptCacheStats: ChatSessionStats;
  lastTurnTelemetry: LastTurnTelemetry;
```

Destructure `sessionPromptCacheStats` and `lastTurnTelemetry` in the component signature (they are currently omitted), then render the bar as the last child of `.composer`, directly after the closing `</div>` of `.row` (line 472):

```tsx
              <ChatStatsBar
                lastTurn={lastTurnTelemetry}
                sessionStats={sessionPromptCacheStats}
                contextUsage={contextUsage}
                streaming={selectedSessionBusy}
              />
```

- [ ] **Step 6: Supply the prop from the controller**

In `dashboard/src/hooks/useChatController.ts`, add `getLastTurnTelemetry` to the `../lib/format` import (line 3), compute it next to line 46:

```ts
  const lastTurnTelemetry = getLastTurnTelemetry(selectedSession);
```

and add `lastTurnTelemetry,` to `tabProps` after `sessionPromptCacheStats` (line 91).

- [ ] **Step 7: Add the styles**

Append to `dashboard/src/styles/chat.css`:

```css
.chat-stats { display: flex; flex-wrap: wrap; gap: 12px; font-size: 0.64rem; color: var(--dim); font-family: ui-monospace, Consolas, monospace; }
.chat-stats.streaming { opacity: 0.55; }
.chat-stat { display: inline-flex; align-items: center; gap: 4px; position: relative; cursor: help; }
.chat-stat-icon { font-size: 0.72rem; }
.chat-stat:hover::after { content: attr(data-tip); position: absolute; bottom: calc(100% + 6px); left: 0; z-index: 40; width: max-content; max-width: 260px; white-space: normal; background: var(--panel2); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; color: var(--ink); font-family: inherit; font-size: 0.64rem; line-height: 1.35; }
```

- [ ] **Step 8: Update the `ChatTab` prop fixture**

Add `lastTurnTelemetry: { promptTokensPerSecond: null, generationTokensPerSecond: null, ttftMs: null },` to `buildProps` in `dashboard/tests/chat-tab.test.tsx` (line 81 area).

- [ ] **Step 9: Run the dashboard suite**

Run: `npm run build:test` then `npm run test:dashboard`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add dashboard/src dashboard/tests dashboard/src/styles/chat.css
git commit -m "feat(chat): add an inference performance HUD under the chat composer"
```

---

## Task 13: Full verification

**Files:** none

- [ ] **Step 1: Typecheck and lint**

Run: `npm run typecheck 2>&1 | siftkit summary --question "Return pass/fail, every TypeScript or ESLint error with file:line, and the error category."`
Expected: pass, zero errors.

- [ ] **Step 2: Full test suite**

Run: `npm run test 2>&1 | siftkit summary --question "Return pass/fail, failing test names, root errors, and relevant file:line anchors."`
Expected: pass.

- [ ] **Step 3: Confirm the tree is clean of scratch files**

Run: `git status --short`
Expected: only intended source, test and doc changes.

- [ ] **Step 4: Commit any residual fixture updates**

```bash
git add -A
git commit -m "test: update chat fixtures for image tokens and telemetry props"
```
