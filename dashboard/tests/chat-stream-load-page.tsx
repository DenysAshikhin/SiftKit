import React from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles.css';
import { consumeChatStream } from '../src/api';
import { ChatTab } from '../src/tabs/ChatTab';
import { ChatRuntimeHub } from '../src/lib/chat-runtime-hub';
import { toRuntimeTransitions } from '../src/lib/chat-stream-transitions';
import { summarizeChatSession } from '../src/hooks/useChatSessions';
import { FIXTURE_OPERATION_ID } from './chat-snapshot-fixture.js';
import { LOAD_SUBMISSION_ID, type StreamLoadResult } from './chat-stream-load-content.js';
import { SESSION_A, buildDefaultStore, buildProps, msg } from './chat-tab-fixture.js';

/** The real ChatTab fed by the real stream client; tests/process/chat-stream-load.test.ts drives and measures it. */
declare global {
  interface Window { runStreamLoad?: () => Promise<StreamLoadResult> }
}

const params = new URLSearchParams(window.location.search);
const rendered = params.get('render') !== '0';
const HISTORY_ANSWER = [
  'Here is what changed:', '- the store splits live state\n- the hub notifies once\n- selectors read owned values',
  '```ts\nconst runtime = selectRuntime(store, sessionId);\n```', '| step | result |\n| --- | --- |\n| build | ok |\n| test | ok |',
].join('\n\n');
const session = { ...SESSION_A, messages: Array.from({ length: Number(params.get('history') ?? '0') }, (_, index) => (index % 2 === 0
  ? msg({ id: `h${String(index)}`, role: 'user', kind: 'user_text', content: `Question ${String(index)}: what changed?` })
  : msg({ id: `h${String(index)}`, kind: 'assistant_answer', content: HISTORY_ANSWER, sourceRunId: `run-${String(index)}` }))) };
const hub = new ChatRuntimeHub(buildDefaultStore(session.id)
  .apply({ kind: 'submit', sessionId: session.id, content: 'go', images: [], submissionId: LOAD_SUBMISSION_ID }));

function nextFrame(): Promise<void> {
  return new Promise((resolve) => { requestAnimationFrame(() => resolve()); });
}

/** Drains the stream as useChatSessions' owned-submission loop does, counting frames and long tasks meanwhile. */
async function runStreamLoad(): Promise<StreamLoadResult> {
  let frames = 0;
  let counting = true;
  const tick = (): void => {
    frames += 1;
    if (counting) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  let longTasks = 0;
  let longTaskMs = 0;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      longTasks += 1;
      longTaskMs += entry.duration;
    }
  });
  observer.observe({ type: 'longtask' });
  const started = performance.now();
  let snapshots = 0;
  const stream = toRuntimeTransitions(session.id, { kind: 'owned', operationKind: 'message', operationId: FIXTURE_OPERATION_ID,
    submissionId: LOAD_SUBMISSION_ID }, consumeChatStream('/stream', { method: 'GET' }, 'error'), true);
  for await (const transition of stream) {
    // The terminal refresh replaces the live view with stored history; only the streamed turn is measured.
    if (transition.kind === 'terminal') break;
    if (transition.kind === 'failure') throw new Error(transition.message);
    if (transition.kind !== 'snapshot') {
      hub.apply(transition);
      continue;
    }
    snapshots += 1;
    hub.apply(transition, { kind: 'submission-phase', sessionId: session.id, submissionId: LOAD_SUBMISSION_ID, phase: 'streaming' });
  }
  await nextFrame();
  const wallMs = performance.now() - started;
  counting = false;
  observer.disconnect();
  const answer = hub.getStore().getLive(session.id).liveMessages.find((message) => message.kind === 'assistant_answer')?.content ?? '';
  const lastWord = answer.trim().split(/\s+/u).at(-1) ?? '';
  const text = document.querySelector('.msgs')?.textContent ?? '';
  return { snapshots, answerChars: answer.length, lastWordRendered: lastWord !== '' && text.includes(lastWord), wallMs, frames, longTasks, longTaskMs };
}

const host = document.getElementById('root');
if (!host) throw new Error('The load page has no root.');
if (rendered) {
  createRoot(host).render(<div className="view on" style={{ width: 1000, height: 800 }}>
    <ChatTab {...buildProps({ selectedSession: session, sessions: [summarizeChatSession(session)], runtimeHub: hub })} />
  </div>);
}
window.runStreamLoad = runStreamLoad;
