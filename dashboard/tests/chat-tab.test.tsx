import './react-test-environment.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatSessionResponseSchema } from '@siftkit/contracts';
import { fireEvent, render as renderComponent, screen } from './react-test-environment.js';
import { ChatSessionRuntimeStore } from '../src/lib/chat-session-runtime-store';
import { ChatTab } from '../src/tabs/ChatTab';
import type { ChatMessage, ChatSession, ChatSessionOperationKind, ContextUsage, DashboardPreset } from '../src/types';
import type { PendingImage } from '../src/lib/downscale-image';
import { DashboardTestServer } from '../../tests/helpers/dashboard-server-fixture.js';
import { requestJson, requestSse } from '../../tests/helpers/dashboard-http.js';
import { getDefaultConfig, writeConfig } from '../../src/status-server/config-store.js';
import { getActiveModelPreset } from '../../src/config/getters.js';
import { getRuntimeDatabasePath } from '../../src/state/runtime-db.js';
import { getRuntimeRoot } from '../../src/config/paths.js';
import { saveChatSession } from '../../src/state/chat-sessions.js';

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
  thinkingEnabled: true, presetId: PRESET.id, mode: 'chat',  createdAtUtc: '2026-04-16T11:00:00.000Z', updatedAtUtc: '2026-04-16T12:00:00.000Z',
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

test('a running tool message renders a neutral friendly activity row', () => {
  const store = buildDefaultStore('session-a')
    .apply({ kind: 'begin', sessionId: 'session-a', operationKind: 'message' })
    .apply({ kind: 'tool', sessionId: 'session-a', toolEvent: {
      kind: 'tool_start', toolCallId: 'tool', turn: 1, maxTurns: 2, toolCallLimit: 2,
      activityKind: 'search', activitySubject: { kind: 'none' }, command: 'rg x', promptTokenCount: 0,
    } });
  const markup = render({ selectedRuntime: store.get('session-a'), sessionRuntimes: store.getAll() });
  const recentActivity = /<section class="recent-activity"[\s\S]*?<\/section>/u.exec(markup)?.[0] ?? '';
  assert.match(markup, /tool-activity-row tool-activity-neutral/u);
  assert.doesNotMatch(recentActivity, /class="sp"/u);
  assert.match(markup, /Searching code…/u);
  assert.doesNotMatch(markup, /rg x/u);
});

test('live recent activity renders only the newest three tools with latest turn progress', () => {
  let store = buildThinkingStore({ content: 'find it', images: [], operationKind: 'repo-search', marker: 'THINK_MARKER_RING' });
  for (const [index, toolCallId] of ['t1', 't2', 't3', 't4'].entries()) {
    store = store.apply({
      kind: 'tool',
      sessionId: SESSION_B.id,
      toolEvent: index === 3
        ? {
            kind: 'tool_start', toolCallId, turn: index + 1, maxTurns: 45, toolCallLimit: 45,
            activityKind: 'search', activitySubject: { kind: 'none' }, command: `rg marker-${index}`, promptTokenCount: 0,
          }
        : {
            kind: 'tool_result', toolCallId, turn: index + 1, maxTurns: 45, toolCallLimit: 45,
            activityKind: 'search', activitySubject: { kind: 'none' }, command: `rg marker-${index}`, promptTokenCount: 0,
            exitCode: 0, outputSnippet: `result-${index}`, outputTokens: 0, outputTokensEstimated: false,
          },
    });
  }
  const markup = render({
    selectedSessionId: SESSION_B.id,
    selectedRuntime: store.get(SESSION_B.id),
    sessionRuntimes: store.getAll(),
  });
  assert.match(markup, /Recent activity/u);
  assert.match(markup, />4\/45</u);
  assert.equal(markup.match(/class="tool-activity-row tool-activity-neutral"/gu)?.length, 3);
  assert.doesNotMatch(markup, /rg marker-/u);
  assert.doesNotMatch(markup, /assistant tool/u, 'recent activity must use compact rows, not nested message bubbles');
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
  assert.match(markup, /Recent activity/u, 'the activity shell starts with the request, before model output');
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

test('an image-only bubble surfaces its known image token count', () => {
  const session = {
    ...SESSION_A,
    messages: [msg({
      id: 'u1',
      role: 'user',
      kind: 'user_text',
      content: '',
      inputTokensEstimate: 0,
      inputTokensEstimated: false,
      images: [IMAGE],
      imageMeta: [{ ...IMAGE_META, tokenEstimate: 2048 }],
    })],
  };

  const markup = render({ selectedSession: session });

  assert.match(markup, /2,048 image tokens/u);
  assert.doesNotMatch(markup, /tokens unavailable/u);
});

const COMPACTED_SESSION = {
  ...SESSION_A,
  id: 'session-compacted',
  messages: [
    msg({ id: 'c1', role: 'user', kind: 'user_text', content: 'old question', compressedIntoSummary: true }),
    msg({ id: 'c2', kind: 'assistant_answer', content: 'old answer', compressedIntoSummary: true }),
    msg({ id: 'c3', kind: 'compaction_summary', content: 'SUMMARY OF THE OLD EXCHANGE' }),
    msg({ id: 'c4', role: 'user', kind: 'user_text', content: 'new question' }),
    msg({ id: 'c5', kind: 'assistant_answer', content: 'new answer' }),
  ],
} satisfies ChatSession;

const TWICE_COMPACTED_SESSION = {
  ...COMPACTED_SESSION,
  id: 'session-twice-compacted',
  messages: [
    msg({ id: 'o1', role: 'user', kind: 'user_text', content: 'original question', compressedIntoSummary: true }),
    msg({ id: 'o2', kind: 'assistant_answer', content: 'original answer', compressedIntoSummary: true }),
    msg({ id: 's1', kind: 'compaction_summary', content: 'FIRST SUMMARY', compressedIntoSummary: true }),
    msg({ id: 'm1', role: 'user', kind: 'user_text', content: 'middle question', compressedIntoSummary: true }),
    msg({ id: 'm2', kind: 'assistant_answer', content: 'middle answer', compressedIntoSummary: true }),
    msg({ id: 's2', kind: 'compaction_summary', content: 'LATEST SUMMARY' }),
    msg({ id: 'n1', role: 'user', kind: 'user_text', content: 'live question' }),
    msg({ id: 'n2', kind: 'assistant_answer', content: 'live answer' }),
  ],
} satisfies ChatSession;

test('a compacted session renders the divider, the collapsed originals and the summary card', () => {
  const markup = render({
    sessions: [COMPACTED_SESSION],
    selectedSessionId: COMPACTED_SESSION.id,
    selectedSession: COMPACTED_SESSION,
  });

  assert.match(markup, /Context compacted \(2 messages summarized\)/u);
  assert.match(markup, /compaction-originals/u);
  assert.match(markup, /Compacted summary/u);
  assert.match(markup, /SUMMARY OF THE OLD EXCHANGE/u);
  assert.match(markup, /old answer/u);
  assert.match(markup, /new answer/u);
});

test('repeated compaction renders one closed fold, the latest summary, then live messages', () => {
  const markup = render({
    sessions: [TWICE_COMPACTED_SESSION],
    selectedSessionId: TWICE_COMPACTED_SESSION.id,
    selectedSession: TWICE_COMPACTED_SESSION,
  });
  const foldStart = markup.indexOf('<details class="compaction-history">');
  const foldEnd = markup.indexOf('</details>', foldStart);
  const foldedMarkup = markup.slice(foldStart, foldEnd);
  const latestSummaryIndex = markup.indexOf('LATEST SUMMARY');
  const liveQuestionIndex = markup.indexOf('live question');
  const liveAnswerIndex = markup.indexOf('live answer');

  assert.ok(foldStart >= 0);
  assert.ok(foldEnd > foldStart);
  assert.equal((markup.match(/<details class="compaction-history">/gu) ?? []).length, 1);
  assert.equal((foldedMarkup.match(/<article class="msg/gu) ?? []).length, 5);
  assert.match(foldedMarkup, /FIRST SUMMARY/u);
  assert.ok(latestSummaryIndex > foldEnd);
  assert.ok(liveQuestionIndex > latestSummaryIndex);
  assert.ok(liveAnswerIndex > liveQuestionIndex);
});

test('a real compacting stream persists and immediately renders one boundary', async () => {
  const server = await DashboardTestServer.start('siftkit-chat-compaction-ui-e2e-');
  try {
    const config = getDefaultConfig();
    const preset = getActiveModelPreset(config);
    preset.Model = 'mock';
    preset.NumCtx = 9_000;
    preset.MaxTokens = 512;
    writeConfig(getRuntimeDatabasePath(), config);

    const created = ChatSessionResponseSchema.parse((await requestJson(
      `${server.baseUrl}/dashboard/chat/sessions`,
      { method: 'POST', body: JSON.stringify({ title: 'Compaction E2E' }) },
    )).body);
    const seededMessages = [
      msg({
        id: 'prior-user',
        role: 'user',
        kind: 'user_text',
        content: `prior completed question ${'X'.repeat(24_000)}`,
      }),
      msg({
        id: 'prior-answer',
        role: 'assistant',
        kind: 'assistant_answer',
        content: 'prior completed answer',
      }),
    ];
    saveChatSession(getRuntimeRoot(), {
      ...created.session,
      modelPreset: preset,
      messages: seededMessages,
    });

    const triggerQuestion = `trigger question ${'Q'.repeat(12_000)}`;
    const stream = await requestSse(
      `${server.baseUrl}/dashboard/chat/sessions/${encodeURIComponent(created.session.id)}/messages/stream`,
      {
        method: 'POST',
        timeoutMs: 10_000,
        body: JSON.stringify({
          content: triggerQuestion,
          webSearchOverride: 'off',
          maxTurns: 1,
          availableModels: ['mock'],
          mockResponses: [
            { content: 'COMPLETE COMPACTION SUMMARY' },
            { content: '{"action":"finish","output":"fresh answer"}' },
          ],
        }),
      },
    );
    assert.equal(stream.statusCode, 200);
    const doneEvent = stream.events.find((event) => event.event === 'done');
    assert.ok(doneEvent?.payload, JSON.stringify(stream.events));
    const terminal = ChatSessionResponseSchema.parse(doneEvent.payload);
    const activeSummaries = terminal.session.messages.filter(
      (message) => message.kind === 'compaction_summary' && message.compressedIntoSummary !== true,
    );
    assert.equal(activeSummaries.length, 1);
    const summaryIndex = terminal.session.messages.findIndex((message) => message.id === activeSummaries[0]?.id);
    assert.ok(summaryIndex > 0);
    assert.equal(
      terminal.session.messages.slice(0, summaryIndex).every((message) => message.compressedIntoSummary === true),
      true,
    );
    assert.equal(terminal.contextUsage.shouldCondense, false);
    assert.ok(terminal.contextUsage.remainingTokens > terminal.contextUsage.warnThresholdTokens);

    const responseStore = new ChatSessionRuntimeStore()
      .ensureSession(terminal.session.id)
      .apply({ kind: 'done', sessionId: terminal.session.id, response: terminal });
    const markup = render({
      sessions: [terminal.session],
      selectedSessionId: terminal.session.id,
      selectedSession: terminal.session,
      selectedRuntime: responseStore.get(terminal.session.id),
      sessionRuntimes: responseStore.getAll(),
    });
    const foldStart = markup.indexOf('<details class="compaction-history">');
    const foldEnd = markup.indexOf('</details>', foldStart);
    const visibleSummaryIndex = markup.indexOf('COMPLETE COMPACTION SUMMARY');
    const triggerIndex = markup.indexOf('trigger question');
    const answerIndex = markup.indexOf('fresh answer');
    assert.ok(foldStart >= 0);
    assert.ok(foldEnd > foldStart);
    assert.equal((markup.match(/<details class="compaction-history">/gu) ?? []).length, 1);
    assert.ok(visibleSummaryIndex > foldEnd);
    assert.ok(triggerIndex > visibleSummaryIndex);
    assert.ok(answerIndex > triggerIndex);
  } finally {
    await server.close();
  }
});

test('a flagged message after the summary row stays in compacted history', () => {
  // The boundary is the persisted flag, not row order: the model replays exactly the
  // rows that are not flagged, and the transcript has to show the same split.
  const session = {
    ...COMPACTED_SESSION,
    id: 'session-compacted-out-of-order',
    messages: [
      ...COMPACTED_SESSION.messages,
      msg({ id: 'c6', kind: 'assistant_answer', content: 'stale flagged answer', compressedIntoSummary: true }),
    ],
  } satisfies ChatSession;

  const markup = render({ sessions: [session], selectedSessionId: session.id, selectedSession: session });

  assert.match(markup, /Context compacted \(3 messages summarized\)/u);
  assert.match(markup, /compaction-originals[\s\S]*stale flagged answer/u);
});

test('flagged messages stay hidden from the live conversation when the summary row is gone', () => {
  // Nothing may replay a flagged row as live conversation just because no summary row
  // survived next to it — the flag alone decides.
  const session = {
    ...SESSION_A,
    id: 'session-flags-without-summary',
    messages: [
      msg({ id: 'f1', role: 'user', kind: 'user_text', content: 'orphaned question', compressedIntoSummary: true }),
      msg({ id: 'f2', kind: 'assistant_answer', content: 'orphaned answer', compressedIntoSummary: true }),
      msg({ id: 'f3', kind: 'assistant_answer', content: 'live answer' }),
    ],
  } satisfies ChatSession;

  const markup = render({ sessions: [session], selectedSessionId: session.id, selectedSession: session });

  assert.match(markup, /live answer/u);
  assert.match(markup, /compaction-originals[\s\S]*orphaned answer/u);
  assert.doesNotMatch(markup, /Compacted summary/u);
});

test('a session with no compaction renders no divider', () => {
  const markup = render();

  assert.doesNotMatch(markup, /Context compacted/u);
  assert.doesNotMatch(markup, /Compacted summary/u);
});

test('the condensed summary panel is gone', () => {
  const markup = render();

  assert.doesNotMatch(markup, /Condensed Summary/u);
});

function buildThinkingStore(options: {
  content: string;
  images: PendingImage[];
  operationKind: ChatSessionOperationKind;
  marker: string;
}): ChatSessionRuntimeStore {
  return new ChatSessionRuntimeStore()
    .ensureSession(SESSION_B.id)
    .apply({ kind: 'submit', sessionId: SESSION_B.id, content: options.content, images: options.images })
    .apply({ kind: 'begin', sessionId: SESSION_B.id, operationKind: options.operationKind })
    .apply({ kind: 'thinking', sessionId: SESSION_B.id, delta: { turn: 1, offset: 0, text: options.marker } });
}

test('a live turn that has only streamed thinking renders the thinking text', () => {
  const store = buildThinkingStore({
    content: '',
    images: [{ dataUrl: IMAGE, note: null }],
    operationKind: 'message',
    marker: 'THINK_MARKER_ONE',
  });
  const html = render({
    selectedSessionId: SESSION_B.id,
    selectedRuntime: store.get(SESSION_B.id),
    sessionRuntimes: store.getAll(),
  });
  assert.ok(html.includes('THINK_MARKER_ONE'), 'streamed thinking must be in the DOM before the answer arrives');
});

test('a live turn that has only streamed thinking renders no empty Internal Logic disclosure', () => {
  const store = buildThinkingStore({ content: 'hello', images: [], operationKind: 'message', marker: 'THINK_MARKER_ONE' });
  const html = render({
    selectedSessionId: SESSION_B.id,
    selectedRuntime: store.get(SESSION_B.id),
    sessionRuntimes: store.getAll(),
  });
  assert.ok(html.includes('THINK_MARKER_ONE'), 'streamed thinking must be in the DOM for a text-only submit too');
  assert.ok(!html.includes('Internal Logic (0)'), 'an empty Internal Logic disclosure must not render');
  assert.ok(html.includes('Recent activity'), 'the activity ring shell must render before the first tool call');
});

test('once the answer streams, the answer and the thinking both render', () => {
  const store = buildThinkingStore({ content: 'hello', images: [], operationKind: 'message', marker: 'THINK_MARKER_ONE' })
    .apply({ kind: 'answer', sessionId: SESSION_B.id, delta: { turn: 1, offset: 0, text: 'ANSWER_MARKER' } });
  const html = render({
    selectedSessionId: SESSION_B.id,
    selectedRuntime: store.get(SESSION_B.id),
    sessionRuntimes: store.getAll(),
  });
  assert.ok(html.includes('ANSWER_MARKER'), 'the streamed answer must render');
  assert.ok(html.includes('THINK_MARKER_ONE'), 'the thinking must remain visible once the answer arrives');
});

test('a live turn with a running tool call renders recent activity and the thinking that led to it', () => {
  const store = buildThinkingStore({ content: 'find it', images: [], operationKind: 'repo-search', marker: 'THINK_MARKER_TOOL' })
    .apply({
      kind: 'tool',
      sessionId: SESSION_B.id,
      toolEvent: {
        kind: 'tool_start', toolCallId: 't1', turn: 1, maxTurns: 4, toolCallLimit: 4,
        activityKind: 'command', activitySubject: { kind: 'none' }, command: 'TOOL_MARKER', promptTokenCount: 0,
      },
    });
  const html = render({
    selectedSessionId: SESSION_B.id,
    selectedRuntime: store.get(SESSION_B.id),
    sessionRuntimes: store.getAll(),
  });
  assert.ok(html.includes('Recent activity'), 'the running tool call must render in recent activity');
  assert.ok(html.includes('1/4'), 'tool progress must count calls against the enforced tool-call limit');
  assert.ok(html.includes('Running command…'), 'the running tool call must render a friendly label');
  assert.ok(!html.includes('TOOL_MARKER'), 'the running tool call must not expose its raw command');
  assert.ok(html.includes('THINK_MARKER_TOOL'), 'the thinking that led to the tool call must render');
});

test('the activity ring disappears into Internal Logic when final answer streaming begins', () => {
  const store = buildThinkingStore({ content: 'find it', images: [], operationKind: 'repo-search', marker: 'THINK_MARKER_ANSWER' })
    .apply({
      kind: 'tool',
      sessionId: SESSION_B.id,
      toolEvent: {
        kind: 'tool_start', toolCallId: 't1', turn: 1, maxTurns: 4, toolCallLimit: 4,
        activityKind: 'command', activitySubject: { kind: 'none' }, command: 'TOOL_MARKER_ANSWER', promptTokenCount: 0,
      },
    })
    .apply({ kind: 'answer', sessionId: SESSION_B.id, delta: { turn: 2, offset: 0, text: 'FINAL_ANSWER_MARKER' } });
  const html = render({
    selectedSessionId: SESSION_B.id,
    selectedRuntime: store.get(SESSION_B.id),
    sessionRuntimes: store.getAll(),
  });
  const logicStart = html.indexOf('<details class="internal-logic">');
  const logicEnd = html.indexOf('</details>', logicStart);
  const logic = html.slice(logicStart, logicEnd);
  assert.ok(logicStart >= 0, 'Internal Logic must contain the completed live activity');
  assert.match(logic, /Running command\u2026/u, 'the friendly tool status moves into Internal Logic');
  assert.ok(!html.includes('Recent activity'), 'the visible activity ring ends when answer streaming begins');
  assert.ok(html.includes('FINAL_ANSWER_MARKER'), 'the final answer remains visible');
});

test('raw streamed model progress renders only inside closed Internal Logic', () => {
  const store = buildThinkingStore({ content: 'find it', images: [], operationKind: 'repo-search', marker: 'THINK_MARKER_PROGRESS' })
    .apply({ kind: 'progress', sessionId: SESSION_B.id, progress: { turn: 1, text: 'PROGRESS_MARKER_ONE', elapsedMs: 500 } })
    .apply({
      kind: 'tool',
      sessionId: SESSION_B.id,
      toolEvent: {
        kind: 'tool_start', toolCallId: 't1', turn: 1, maxTurns: 4, toolCallLimit: 4,
        activityKind: 'command', activitySubject: { kind: 'none' }, command: 'TOOL_MARKER', promptTokenCount: 0,
      },
    })
    .apply({ kind: 'progress', sessionId: SESSION_B.id, progress: { turn: 2, text: 'PROGRESS_MARKER_TWO', elapsedMs: 900 } });
  const html = render({
    selectedSessionId: SESSION_B.id,
    selectedRuntime: store.get(SESSION_B.id),
    sessionRuntimes: store.getAll(),
  });
  assert.ok(!html.includes('PROGRESS_MARKER_ONE'), 'a newer progress event must replace the previous bar text');
  assert.ok(html.includes('PROGRESS_MARKER_TWO'), 'the latest progress text must render');
  assert.ok(!html.includes('turn-progress-bar'), 'raw model progress must not render as an exposed block');
  const logicStart = html.indexOf('<details class="internal-logic">');
  const logicEnd = html.indexOf('</details>', logicStart);
  const logic = html.slice(logicStart, logicEnd);
  assert.ok(logicStart >= 0, 'Internal Logic must render');
  assert.ok(logic.includes('PROGRESS_MARKER_TWO'), 'raw model progress must stay inside Internal Logic');
  assert.ok(html.includes('Recent activity'), 'the friendly activity ring remains visible before the answer');
});
