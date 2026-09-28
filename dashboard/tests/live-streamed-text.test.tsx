import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act, Profiler } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { LiveStreamedText, STREAM_ADVANCE_INTERVAL_MS, type StreamFormat } from '../src/components/LiveStreamedText';

type Harness = {
  container: HTMLElement;
  root: Root;
  /** React commits of the streamed text since setup. */
  commits(): number;
  /** Advances the fake clock to `atMs` and runs the ticks queued before it. */
  tickAt(atMs: number): Promise<void>;
  setNow(atMs: number): void;
  pendingTicks(): number;
  cancelledTicks(): number;
  delays(): number[];
  teardown(): Promise<void>;
};

function replaceGlobal(key: PropertyKey, value: object | boolean): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
  return () => {
    if (original) {
      Object.defineProperty(globalThis, key, original);
      return;
    }
    Reflect.deleteProperty(globalThis, key);
  };
}

/** Only now() is faked: React's dev build also uses the other performance methods. */
function overrideClock(now: () => number): () => void {
  Object.defineProperty(performance, 'now', { configurable: true, value: now, writable: true });
  return () => { Reflect.deleteProperty(performance, 'now'); };
}

let commitCount = 0;

function setup(): Harness {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  const container = dom.window.document.getElementById('root');
  if (!container) {
    throw new Error('Test root was not created.');
  }
  let now = 0;
  let nextTickId = 1;
  let cancelled = 0;
  const ticks = new Map<number, () => void>();
  const delays: number[] = [];
  // Only the page's timers are faked; React schedules its own work on Node's.
  Object.defineProperty(dom.window, 'setTimeout', { configurable: true, value: (callback: () => void, delay: number) => {
    const id = nextTickId;
    nextTickId += 1;
    ticks.set(id, callback);
    delays.push(delay);
    return id;
  } });
  Object.defineProperty(dom.window, 'clearTimeout', { configurable: true, value: (id: number) => {
    if (ticks.delete(id)) cancelled += 1;
  } });
  const restores = [
    replaceGlobal('window', dom.window),
    replaceGlobal('document', dom.window.document),
    replaceGlobal('navigator', dom.window.navigator),
    replaceGlobal('IS_REACT_ACT_ENVIRONMENT', true),
    overrideClock(() => now),
  ];
  commitCount = 0;
  const root = createRoot(container);
  return {
    container,
    root,
    commits: () => commitCount,
    tickAt: async (atMs) => {
      now = atMs;
      const due = [...ticks.values()];
      ticks.clear();
      await act(async () => {
        for (const callback of due) callback();
      });
    },
    setNow: (atMs) => { now = atMs; },
    pendingTicks: () => ticks.size,
    cancelledTicks: () => cancelled,
    delays: () => delays,
    teardown: async () => {
      await act(async () => root.unmount());
      for (const restore of restores.reverse()) restore();
      dom.window.close();
    },
  };
}

async function render(harness: Harness, text: string, live: boolean, format: StreamFormat = 'markdown'): Promise<void> {
  await act(async () => {
    harness.root.render(
      <Profiler id="stream" onRender={() => { commitCount += 1; }}>
        <div data-testid="output"><LiveStreamedText text={text} live={live} format={format} /></div>
      </Profiler>,
    );
  });
}

function output(harness: Harness): Element {
  const element = harness.container.querySelector('[data-testid="output"]');
  if (!element) throw new Error('No output element.');
  return element;
}

function tail(harness: Harness): HTMLElement | null {
  return output(harness).querySelector<HTMLElement>('.stream-tail');
}

/** Ticks every 33 ms until the pacer catches up, returning the tail text after each tick. */
async function drain(harness: Harness, fromMs: number): Promise<string[]> {
  const tails: string[] = [];
  for (let atMs = fromMs; harness.pendingTicks() > 0; atMs += STREAM_ADVANCE_INTERVAL_MS) {
    await harness.tickAt(atMs);
    tails.push(tail(harness)?.textContent ?? '');
  }
  return tails;
}

test('non-live text renders full markdown at once with no tail and no timer', async () => {
  const harness = setup();
  try {
    await render(harness, 'a **b**\n\nc', false);
    assert.equal(output(harness).querySelector('strong')?.textContent, 'b');
    assert.equal(output(harness).querySelectorAll('p').length, 2);
    assert.equal(tail(harness), null);
    assert.equal(harness.pendingTicks(), 0);
  } finally {
    await harness.teardown();
  }
});

test('a fresh live mount shows all existing text: finished blocks as markdown, the last block in the tail', async () => {
  const harness = setup();
  try {
    await render(harness, 'para **one**\n\nsecond **two**', true);
    assert.equal(output(harness).querySelector('strong')?.textContent, 'one');
    assert.equal(tail(harness)?.textContent, 'second **two**');
    assert.equal(harness.pendingTicks(), 0);
  } finally {
    await harness.teardown();
  }
});

test('the tail grows on each tick without any React commit until caught up', async () => {
  const harness = setup();
  try {
    await render(harness, 'abc', true);
    await render(harness, 'abcdefghijklmnop', true);
    assert.equal(tail(harness)?.textContent, 'abc');
    const commitsBefore = harness.commits();
    const tails = await drain(harness, STREAM_ADVANCE_INTERVAL_MS);
    assert.equal(harness.commits(), commitsBefore);
    assert.equal(tails.at(-1), 'abcdefghijklmnop');
    assert.ok(tails.every((text, index) => index === 0 || text.length > (tails[index - 1] ?? '').length), `tails ${tails.join('|')}`);
  } finally {
    await harness.teardown();
  }
});

test('ticks are scheduled no faster than the advance interval', async () => {
  const harness = setup();
  try {
    await render(harness, '', true);
    await render(harness, 'x'.repeat(400), true);
    await drain(harness, STREAM_ADVANCE_INTERVAL_MS);
    assert.ok(harness.delays().length > 1);
    assert.ok(harness.delays().every((delay) => delay === STREAM_ADVANCE_INTERVAL_MS), `delays ${harness.delays().join(',')}`);
    assert.equal(STREAM_ADVANCE_INTERVAL_MS >= 33, true);
  } finally {
    await harness.teardown();
  }
});

test('crossing a block boundary commits the finished block once as markdown and the tail continues after it', async () => {
  const harness = setup();
  try {
    await render(harness, 'x', true);
    await render(harness, 'x **first**\n\nsecond', true);
    const commitsBefore = harness.commits();
    await drain(harness, STREAM_ADVANCE_INTERVAL_MS);
    assert.equal(harness.commits(), commitsBefore + 1);
    assert.equal(output(harness).querySelector('strong')?.textContent, 'first');
    assert.equal(tail(harness)?.textContent, 'second');
  } finally {
    await harness.teardown();
  }
});

test('an open fence tail is marked for monospace and commits as a code block once closed', async () => {
  const harness = setup();
  try {
    await render(harness, 'Intro\n\n```ts\nconst a = 1;\n', true);
    assert.equal(output(harness).querySelector('p')?.textContent, 'Intro');
    await render(harness, 'Intro\n\n```ts\nconst a = 1;\nconst b = 2;\n', true);
    await drain(harness, STREAM_ADVANCE_INTERVAL_MS);
    assert.equal(tail(harness)?.hasAttribute('data-fence'), true);
    assert.equal(tail(harness)?.textContent, '```ts\nconst a = 1;\nconst b = 2;\n');
    await render(harness, 'Intro\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nAfter', true);
    await drain(harness, 1000);
    assert.match(output(harness).querySelector('pre code')?.textContent ?? '', /const b = 2;/u);
    assert.equal(tail(harness)?.textContent, 'After');
    assert.equal(tail(harness)?.hasAttribute('data-fence'), false);
  } finally {
    await harness.teardown();
  }
});

test('updates arriving faster than ticks keep the tail advancing on every tick', async () => {
  const harness = setup();
  try {
    let text = 'abc';
    await render(harness, text, true);
    const lengths: number[] = [];
    // A token every 10 ms against 33 ms ticks: the timer loop must survive every update.
    for (let atMs = 10; atMs <= 400; atMs += 10) {
      harness.setNow(atMs);
      text += 'defg';
      await render(harness, text, true);
      if (atMs % 40 === 0) {
        await harness.tickAt(atMs);
        lengths.push(tail(harness)?.textContent?.length ?? 0);
      }
    }
    assert.equal(text.startsWith(tail(harness)?.textContent ?? '-'), true);
    assert.ok(lengths.every((length, index) => index === 0 || length > (lengths[index - 1] ?? 0)), `lengths ${lengths.join(',')}`);
  } finally {
    await harness.teardown();
  }
});

test('switching live off renders the complete markdown, drops the tail and cancels the pending tick', async () => {
  const harness = setup();
  try {
    await render(harness, 'abc', true);
    await render(harness, 'abc **def**', true);
    assert.equal(harness.pendingTicks(), 1);
    await render(harness, 'abc **def**', false);
    assert.equal(output(harness).querySelector('strong')?.textContent, 'def');
    assert.equal(tail(harness), null);
    assert.equal(harness.pendingTicks(), 0);
    assert.equal(harness.cancelledTicks(), 1);
  } finally {
    await harness.teardown();
  }
});

test('unmounting while behind cancels its pending tick', async () => {
  const harness = setup();
  try {
    await render(harness, 'abc', true);
    await render(harness, 'abcdef', true);
    assert.equal(harness.pendingTicks(), 1);
    await act(async () => harness.root.render(<></>));
    assert.equal(harness.pendingTicks(), 0);
    assert.equal(harness.cancelledTicks(), 1);
  } finally {
    await harness.teardown();
  }
});

test('plain text commits whole paragraphs and ends as the exact text', async () => {
  const harness = setup();
  try {
    await render(harness, 'one', true, 'plain');
    await render(harness, 'one **raw**\n\ntwo', true, 'plain');
    const commitsBefore = harness.commits();
    await drain(harness, STREAM_ADVANCE_INTERVAL_MS);
    assert.equal(harness.commits(), commitsBefore + 1);
    assert.equal(tail(harness)?.textContent, 'two');
    assert.equal(output(harness).textContent, 'one **raw**\n\ntwo');
    await render(harness, 'one **raw**\n\ntwo', false, 'plain');
    assert.equal(output(harness).innerHTML, 'one **raw**\n\ntwo');
  } finally {
    await harness.teardown();
  }
});

test('static rendering of live text includes the tail, since no effect runs to write it', () => {
  const markup = renderToStaticMarkup(<LiveStreamedText text={'done **one**\n\nstill going'} live format="markdown" />);
  assert.ok(markup.includes('<strong>one</strong>'), markup);
  assert.ok(markup.includes('<span class="stream-tail">still going</span>'), markup);
});
