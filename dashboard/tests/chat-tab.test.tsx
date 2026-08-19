import './react-test-environment.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fireEvent, render as renderComponent, screen } from './react-test-environment.js';
import { ChatSessionRuntimeStore } from '../src/lib/chat-session-runtime-store';
import { ChatTab } from '../src/tabs/ChatTab';
import type { ChatMessage, ChatSession, ContextUsage, DashboardPreset } from '../src/types';

const IMAGE = 'data:image/png;base64,AA==';
const IMAGE_META = {
  width: 320,
  height: 200,
  originalWidth: 320,
  originalHeight: 200,
  mime: 'image/png',
  byteLength: 1024,
  tokenEstimate: 64,
  resized: false,
  caption: null,
};

const PRESET = {
  id: 'chat-default', label: 'Chat', description: '', presetKind: 'chat', operationMode: 'full',
  promptPrefix: '', allowedTools: [], surfaces: ['cli', 'web'],
  useForSummary: false, builtin: true, deletable: false, includeAgentsMd: false,
  includeRepoFileListing: false, assistantMemory: false,
  autoloadFiles: [], repoRootRequired: false, maxTurns: null,
} satisfies DashboardPreset;

function msg(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm1', role: 'assistant', content: '',
    inputTokensEstimate: 0, outputTokensEstimate: 0, thinkingTokens: 0,
    createdAtUtc: '2026-07-19T00:00:00Z', sourceRunId: null,
    ...overrides,
  };
}

const SESSION_A = {
  id: 'session-a', title: 'Session A', model: 'test-model', contextWindowTokens: 100,
  thinkingEnabled: true, presetId: PRESET.id, mode: 'chat', condensedSummary: '',
  createdAtUtc: '2026-04-16T11:00:00.000Z', updatedAtUtc: '2026-04-16T12:00:00.000Z',
  messages: [msg({ id: 'a1', kind: 'assistant_answer', content: 'Hello from the assistant.' })],
} satisfies ChatSession;

const SESSION_B = {
  ...SESSION_A,
  id: 'session-b',
  title: 'Session B',
  messages: [],
} satisfies ChatSession;

const CONTEXT_USAGE = {
  shouldCondense: false, chatUsedTokens: 90, thinkingUsedTokens: 0, toolUsedTokens: 0, imageUsedTokens: 0,
  totalUsedTokens: 90, remainingTokens: 10, warnThresholdTokens: 50, contextWindowTokens: 100,
  usedTokens: 90, estimatedTokenFallbackTokens: 0, providerOverheadTokens: 5,
  effectiveImagePixelCeiling: 1_000_000,
} satisfies ContextUsage;

type ChatTabProps = React.ComponentProps<typeof ChatTab>;

function buildDefaultStore(sessionId: string): ChatSessionRuntimeStore {
  return new ChatSessionRuntimeStore()
    .ensureSession('session-a')
    .ensureSession('session-b')
    .apply({ kind: 'draft', sessionId, draft: 'hi' });
}

function buildProps(overrides: Partial<ChatTabProps> = {}): ChatTabProps {
  const selectedSessionId = overrides.selectedSessionId ?? SESSION_A.id;
  const defaultStore = buildDefaultStore(selectedSessionId);
  const props: ChatTabProps = {
    sessions: [SESSION_A, SESSION_B],
    selectedSessionId,
    selectedSession: selectedSessionId === SESSION_B.id ? SESSION_B : SESSION_A,
    selectedRuntime: defaultStore.get(selectedSessionId),
    sessionRuntimes: defaultStore.getAll(),
    sessionPromptCacheStats: { cacheHitRate: 0, promptCacheTokens: 0, promptEvalTokens: 0, acceptanceRate: null, speculativeAcceptedTokens: 0, speculativeGeneratedTokens: 0, promptTokensPerSecond: null, generationTokensPerSecond: null },
    lastTurnTelemetry: { promptTokensPerSecond: null, generationTokensPerSecond: null, ttftMs: null },
    webPresets: [PRESET],
    selectedChatPreset: PRESET,
    chatMode: 'chat',
    isDirectChatMode: true,
    isRepoToolMode: false,
    isThinkingEnabledForCurrentSession: true,
    webSearchEnabled: true,
    showSettings: false,
    onSelectSession: () => {}, onToggleSettings: () => {}, onChangePlanRepoRoot: () => {},
    onChangeDraft: () => {}, onCreateSession: async () => {}, onDeleteSession: async () => {},
    onUpdateSessionPreset: async () => {}, onToggleThinking: async () => {}, onToggleWebSearchEnabled: async () => {},
    onSavePlanRepoRoot: async () => {}, onDeleteMessage: async () => {}, onDeleteTurn: async () => {},
    onDeleteMessageImage: async () => {}, onCondense: async () => {},
    onSendPlan: async () => {}, onSendRepoSearch: async () => {}, onSendMessage: async () => {},
    onPendingImagesChange: () => {},
    onPendingImagesAppend: () => {},
    onPendingImageError: () => {},
    ...overrides,
  };
  return props;
}

function render(overrides: Partial<ChatTabProps> = {}): string {
  return renderToStaticMarkup(React.createElement(ChatTab, buildProps(overrides)));
}

function installImageReadControls(): {
  complete(index: number, dataUrl: string): void;
  restore(): void;
} {
  const originalFetch = globalThis.fetch;
  const originalFileReader = globalThis.FileReader;
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  const completions: Array<(dataUrl: string) => void> = [];
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async () => new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } }),
  });
  Object.defineProperty(globalThis, 'createImageBitmap', {
    configurable: true,
    value: async () => ({ width: 1, height: 1, close: () => undefined }),
  });
  Object.defineProperty(globalThis, 'FileReader', {
    configurable: true,
    value: class {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      readAsDataURL(): void {
        completions.push((dataUrl) => {
          this.result = dataUrl;
          this.onload?.();
        });
      }
    },
  });
  return {
    complete(index, dataUrl) {
      const complete = completions[index];
      if (!complete) throw new Error(`missing image-read completion ${index}`);
      complete(dataUrl);
    },
    restore() {
      Object.defineProperty(globalThis, 'fetch', { configurable: true, value: originalFetch });
      Object.defineProperty(globalThis, 'FileReader', { configurable: true, value: originalFileReader });
      Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: originalCreateImageBitmap });
    },
  };
}

test('attachment read failures are reported to the owning session', async () => {
  const originalFileReader = globalThis.FileReader;
  const errors: Array<{ sessionId: string; message: string }> = [];
  Object.defineProperty(globalThis, 'FileReader', {
    configurable: true,
    value: class {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      readAsDataURL(): void {
        this.onerror?.();
      }
    },
  });
  const store = buildDefaultStore(SESSION_A.id).apply({
    kind: 'context-usage',
    sessionId: SESSION_A.id,
    contextUsage: CONTEXT_USAGE,
  });

  try {
    renderComponent(<ChatTab {...buildProps({
      selectedRuntime: store.get(SESSION_A.id),
      sessionRuntimes: store.getAll(),
      onPendingImageError: (sessionId, message) => errors.push({ sessionId, message }),
    })} />);
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Attach'), {
        target: { files: [new File([new Uint8Array([1])], 'broken.png', { type: 'image/png' })] },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.deepEqual(errors, [{ sessionId: SESSION_A.id, message: 'cannot read broken.png' }]);
  } finally {
    Object.defineProperty(globalThis, 'FileReader', { configurable: true, value: originalFileReader });
  }
});

test('overlapping attachment reads append in selection order', async () => {
  const controls = installImageReadControls();
  const appended: Array<{ sessionId: string; images: string[] }> = [];
  const store = buildDefaultStore(SESSION_A.id).apply({
    kind: 'context-usage',
    sessionId: SESSION_A.id,
    contextUsage: CONTEXT_USAGE,
  });
  try {
    renderComponent(<ChatTab {...buildProps({
      selectedRuntime: store.get(SESSION_A.id),
      sessionRuntimes: store.getAll(),
      onPendingImagesAppend: (sessionId, images) => appended.push({
        sessionId,
        images: images.map((image) => image.dataUrl),
      }),
    })} />);
    const input = screen.getByLabelText('Attach');
    fireEvent.change(input, { target: { files: [new File([new Uint8Array([1])], 'first.png')] } });
    fireEvent.change(input, { target: { files: [new File([new Uint8Array([2])], 'second.png')] } });

    await act(async () => {
      controls.complete(1, 'data:image/png;base64,AQ==');
      await Promise.resolve();
    });
    assert.deepEqual(appended, []);

    await act(async () => {
      controls.complete(0, 'data:image/png;base64,AA==');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(appended, [
      { sessionId: SESSION_A.id, images: ['data:image/png;base64,AA=='] },
      { sessionId: SESSION_A.id, images: ['data:image/png;base64,AQ=='] },
    ]);
  } finally {
    controls.restore();
  }
});

test('switching sessions discards an unresolved attachment batch', async () => {
  const controls = installImageReadControls();
  const appended: string[] = [];
  const store = buildDefaultStore(SESSION_A.id).apply({
    kind: 'context-usage',
    sessionId: SESSION_A.id,
    contextUsage: CONTEXT_USAGE,
  });
  try {
    const rendered = renderComponent(<ChatTab {...buildProps({
      selectedRuntime: store.get(SESSION_A.id),
      sessionRuntimes: store.getAll(),
      onPendingImagesAppend: (sessionId) => appended.push(sessionId),
    })} />);
    fireEvent.change(screen.getByLabelText('Attach'), {
      target: { files: [new File([new Uint8Array([1])], 'first.png')] },
    });
    const sessionBStore = buildDefaultStore(SESSION_B.id).apply({
      kind: 'context-usage',
      sessionId: SESSION_B.id,
      contextUsage: CONTEXT_USAGE,
    });
    await act(async () => {
      rendered.rerender(<ChatTab {...buildProps({
        selectedSessionId: SESSION_B.id,
        selectedSession: SESSION_B,
        selectedRuntime: sessionBStore.get(SESSION_B.id),
        sessionRuntimes: sessionBStore.getAll(),
        onPendingImagesAppend: (sessionId) => appended.push(sessionId),
      })} />);
      await Promise.resolve();
    });
    await act(async () => {
      controls.complete(0, 'data:image/png;base64,AA==');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.deepEqual(appended, []);
  } finally {
    controls.restore();
  }
});

test('chat tab renders session lane, controls, messages, and composer', () => {
  const markup = render();
  assert.match(markup, /class="chat-lane"/);
  assert.match(markup, /New session/);
  assert.match(markup, /class="chat-head"/);
  assert.match(markup, /class="hchip on"[^>]*>web search/);
  assert.match(markup, /class="hchip on"[^>]*>per-step thinking/);
  assert.match(markup, /class="msgs"/);
  assert.match(markup, /class="composer"/);
});

test('busy A stays visible while selected B remains interactive', () => {
  const store = buildDefaultStore('session-b').apply({ kind: 'begin', sessionId: 'session-a', operationKind: 'message' });
  const markup = render({
    selectedSessionId: 'session-b',
    selectedSession: SESSION_B,
    selectedRuntime: store.get('session-b'),
    sessionRuntimes: store.getAll(),
  });
  assert.match(markup, /Session A[\s\S]*streaming/u);
  assert.doesNotMatch(markup, /class="send"[^>]*disabled/u);
  assert.doesNotMatch(markup, /class="ghost-btn acc new"[^>]*disabled/u);
  assert.doesNotMatch(markup, /class="ghost-btn"[^>]*disabled[^>]*>Delete/u);
});

test('selected busy A disables only its mutable controls', () => {
  const store = buildDefaultStore('session-a').apply({ kind: 'begin', sessionId: 'session-a', operationKind: 'message' });
  const markup = render({ selectedRuntime: store.get('session-a'), sessionRuntimes: store.getAll() });
  assert.match(markup, /class="send"[^>]*disabled/u);
  assert.match(markup, /class="ghost-btn"[^>]*disabled[^>]*>Delete/u);
  assert.doesNotMatch(markup, /class="ghost-btn acc new"[^>]*disabled/u);
});

test('selected session alone supplies errors and warnings', () => {
  const store = buildDefaultStore('session-b')
    .apply({ kind: 'warning', sessionId: 'session-a', text: 'warning-a' })
    .apply({ kind: 'failure', sessionId: 'session-a', message: 'error-a' });
  const selectedB = render({
    selectedSessionId: 'session-b',
    selectedSession: SESSION_B,
    selectedRuntime: store.get('session-b'),
    sessionRuntimes: store.getAll(),
  });
  assert.doesNotMatch(selectedB, /warning-a|error-a/u);
  const selectedA = render({
    selectedRuntime: store.get('session-a'),
    sessionRuntimes: store.getAll(),
  });
  assert.match(selectedA, /warning-a/u);
  assert.match(selectedA, /error-a/u);
});

test('a running tool message renders a ToolCallCard with spinner', () => {
  const store = buildDefaultStore('session-a')
    .apply({ kind: 'begin', sessionId: 'session-a', operationKind: 'message' })
    .apply({ kind: 'tool', sessionId: 'session-a', toolEvent: { kind: 'tool_start', toolCallId: 'tool', turn: 1, maxTurns: 2, command: 'rg x' } });
  const markup = render({ selectedRuntime: store.get('session-a'), sessionRuntimes: store.getAll() });
  assert.match(markup, /class="tcall"/);
  assert.match(markup, /class="sp"/);
});

test('selected context usage renders the warning context bar', () => {
  const responseStore = buildDefaultStore('session-a').apply({ kind: 'done', sessionId: 'session-a', response: {
    session: SESSION_A,
    contextUsage: CONTEXT_USAGE,
  }});
  const markup = render({ selectedRuntime: responseStore.get('session-a'), sessionRuntimes: responseStore.getAll() });
  assert.match(markup, /class="ctx warn"/);
});

test('chat does not render first-message context toggles', () => {
  const emptySession = { ...SESSION_A, mode: 'repo-search', messages: [] } satisfies ChatSession;
  const markup = render({ selectedSession: emptySession, chatMode: 'repo-search', isDirectChatMode: false, isRepoToolMode: true });
  assert.doesNotMatch(markup, /Repo-search auto-append controls|File scan/u);
});

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

test('composer attaches images through a styled label wrapping the file input', () => {
  const markup = render();
  assert.match(markup, /<label class="mini-btn attach"[^>]*>Attach<input type="file"/u);
});

test('renders user and tool-image attachments inline', () => {
  const session = {
    ...SESSION_A,
    messages: [
      msg({ id: 'user-image', role: 'user', kind: 'user_text', content: 'Look at this', images: [IMAGE], imageMeta: [IMAGE_META] }),
      msg({ id: 'tool-image', role: 'assistant', kind: 'tool_image', content: 'read output', images: [IMAGE], imageMeta: [IMAGE_META] }),
    ],
  } satisfies ChatSession;
  const markup = render({ selectedSession: session, selectedSessionId: session.id });

  assert.equal((markup.match(/class="message-images"/gu) ?? []).length, 2);
  assert.equal((markup.match(/<img\b/gu) ?? []).length, 2);
});

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

test('the pending bubble survives a warning that arrives before the stream', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession(SESSION_A.id)
    .apply({ kind: 'begin', sessionId: SESSION_A.id, operationKind: 'message' })
    .apply({ kind: 'submit', sessionId: SESSION_A.id, content: 'describe this', images: [] })
    .apply({ kind: 'warning', sessionId: SESSION_A.id, text: 'repo root is dirty' });
  const markup = render({
    selectedRuntime: store.get(SESSION_A.id),
    sessionRuntimes: store.getAll(),
  });

  assert.match(markup, /sending…/u);
});

test('the pending bubble clears once the assistant starts streaming', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession(SESSION_A.id)
    .apply({ kind: 'begin', sessionId: SESSION_A.id, operationKind: 'message' })
    .apply({ kind: 'submit', sessionId: SESSION_A.id, content: 'describe this', images: [] })
    .apply({ kind: 'answer', sessionId: SESSION_A.id, delta: { turn: 1, offset: 0, text: 'here it is' } });
  const markup = render({
    selectedRuntime: store.get(SESSION_A.id),
    sessionRuntimes: store.getAll(),
  });

  assert.doesNotMatch(markup, /sending…/u);
});

test('a bubble token chip separates text tokens from image tokens', () => {
  const session = {
    ...SESSION_A,
    messages: [msg({
      id: 'u1',
      role: 'user',
      kind: 'user_text',
      content: 'look',
      inputTokensEstimate: 12,
      inputTokensEstimated: false,
      images: [IMAGE],
      imageMeta: [{ ...IMAGE_META, tokenEstimate: 1024 }],
    })],
  };
  const markup = render({ selectedSession: session });

  assert.match(markup, /12 tokens \(\+1,024 img\)/u);
});
