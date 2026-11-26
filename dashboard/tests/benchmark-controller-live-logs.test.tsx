import './react-test-environment.ts';

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { act, renderHook } from './react-test-environment.ts';
import { useBenchmarkController } from '../src/hooks/useBenchmarkController.ts';
import type { DashboardBenchmarkSession } from '../src/types.ts';

const SESSION_A: DashboardBenchmarkSession = {
  id: 'benchmark-session-a', status: 'running', questionPresetCount: 1, caseCount: 1, repetitions: 2,
  currentCaseIndex: 0, currentPromptIndex: 0, currentRepeatIndex: 1,
  restoreStatus: 'completed', restoreError: null, originalConfigJson: '{}',
  startedAtUtc: '2026-05-13T12:00:00.000Z', completedAtUtc: null, updatedAtUtc: '2026-05-13T12:00:05.000Z',
};
const SESSION_B: DashboardBenchmarkSession = {
  id: 'benchmark-session-b', status: 'completed', questionPresetCount: 1, caseCount: 1, repetitions: 2,
  currentCaseIndex: 0, currentPromptIndex: 0, currentRepeatIndex: 1,
  restoreStatus: 'completed', restoreError: null, originalConfigJson: '{}',
  startedAtUtc: '2026-05-13T12:00:00.000Z', completedAtUtc: '2026-05-13T12:05:00.000Z', updatedAtUtc: '2026-05-13T12:05:00.000Z',
};

type FakeEventSourceHandler = (event: MessageEvent) => void;

// Records each instance and lets the test deliver MessageEvent-shaped payloads to its listeners.
class FakeBenchmarkEventSource {
  readonly url: string;
  private readonly listeners: Map<string, FakeEventSourceHandler[]> = new Map();
  constructor(url: string) {
    this.url = url;
    openedEventSources.push(this);
  }
  addEventListener(name: string, handler: FakeEventSourceHandler): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), handler]);
  }
  close(): void {
    this.listeners.clear();
  }
  emit(name: string, data: string): void {
    for (const handler of this.listeners.get(name) ?? []) {
      handler(new MessageEvent(name, { data }));
    }
  }
}

const openedEventSources: FakeBenchmarkEventSource[] = [];

function benchmarkSessionFromDetailUrl(url: string): DashboardBenchmarkSession | null {
  const match = /^\/dashboard\/benchmark\/sessions\/([^/?#]+)$/u.exec(url);
  if (!match) {
    return null;
  }
  const id = match[1];
  if (id === SESSION_A.id) {
    return SESSION_A;
  }
  if (id === SESSION_B.id) {
    return SESSION_B;
  }
  return null;
}

test('switching the viewed benchmark session clears the previous session live log lines', async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === '/dashboard/benchmark/question-presets') {
      return new Response(JSON.stringify({ presets: [] }), { status: 200 });
    }
    if (url.startsWith('/dashboard/benchmark/sessions?')) {
      return new Response(JSON.stringify({ sessions: [SESSION_A, SESSION_B] }), { status: 200 });
    }
    const session = benchmarkSessionFromDetailUrl(url);
    if (session) {
      return new Response(JSON.stringify({
        session,
        cases: [],
        attempts: [],
        throughput: { promptTokensPerSecond: null, generationTokensPerSecond: null },
      }), { status: 200 });
    }
    throw new Error(`Unexpected dashboard fetch url: ${url}`);
  };
  Object.assign(globalThis, { EventSource: FakeBenchmarkEventSource });
  try {
    const hook = renderHook(
      ({ refreshToken }) => useBenchmarkController({
        enqueueToast: () => {},
        refreshToken,
        requestDashboardDataRefresh: () => {},
        tab: 'benchmark',
        managedPresets: [],
      }),
      { initialProps: { refreshToken: 0 } },
    );
    await act(async () => {});
    assert.equal(openedEventSources.length, 1);
    assert.equal(openedEventSources[0]?.url, '/dashboard/benchmark/sessions/benchmark-session-a/events');
    const sessionSource = openedEventSources[0];
    assert.ok(sessionSource);
    act(() => { sessionSource.emit('log', JSON.stringify({ text: 'first session line' })); });
    assert.deepEqual(hook.result.current.tabProps.liveLogLines, ['first session line']);
    // A dashboard data refresh keeps the same running session selected and must not wipe its log.
    await act(async () => { hook.rerender({ refreshToken: 1 }); });
    assert.deepEqual(hook.result.current.tabProps.liveLogLines, ['first session line']);
    await act(async () => { hook.result.current.tabProps.onSelectSession(SESSION_B.id); });
    assert.deepEqual(hook.result.current.tabProps.liveLogLines, []);
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(globalThis, { EventSource: originalEventSource });
  }
});