import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { z } from 'zod';
import { createChatUpdateRecords, encodeChatProjectionRecords } from '../../src/status-server/chat-projection-encoder.js';
import { HeadlessChrome, bundleBrowserPage, bundleResponse, type BrowserPage } from '../helpers/browser-page.js';
import {
  FIXTURE_OPERATION_ID, chatProjectionCapture, chatSnapshotFrames, nextTransferId, projectionPackets, singleRecordFrames, terminalRecord,
} from '../../dashboard/tests/chat-snapshot-fixture.js';
import { liveTranscriptSnapshot, type LiveTranscriptStep } from '../../dashboard/tests/live-transcript-fixture.js';
import {
  LOAD_ANSWER_TOKENS, LOAD_SESSION_ID, LOAD_THINKING_TOKENS, LOAD_TOKENS_PER_SECOND, StreamLoadResultSchema, loadTokenText,
} from '../../dashboard/tests/chat-stream-load-content.js';

const TOKENS = LOAD_THINKING_TOKENS + LOAD_ANSWER_TOKENS;
/** How much more main-thread time per token a long history may cost than an empty one. */
const HISTORY_COST_CEILING = 1.25;
const SCENARIOS = [
  { id: 'pipeline', name: 'pipeline only (no React)', build: 'prod', query: 'render=0', rendered: false },
  { id: 'empty', name: 'ChatTab, empty history', build: 'prod', query: 'history=0', rendered: true },
  { id: 'history200', name: 'ChatTab, 200-row history', build: 'prod', query: 'history=200', rendered: true },
  { id: 'history1000', name: 'ChatTab, 1000-row history', build: 'prod', query: 'history=1000', rendered: true },
  { id: 'dev200', name: 'ChatTab, 200-row history, React dev build', build: 'dev', query: 'history=200', rendered: true },
] as const;
type ScenarioId = (typeof SCENARIOS)[number]['id'];
/** Scenarios whose per-token cost must stay within HISTORY_COST_CEILING of the empty history. */
const LONG_HISTORIES: readonly ScenarioId[] = ['history200', 'history1000'];

/** The SSE body the server would send: one snapshot, one update per token, the completed view, then the terminal record. */
function streamPackets(): { packets: string[]; answerChars: number } {
  const steps: LiveTranscriptStep[] = [{ kind: 'prompt', prompt: { turn: 1, maxTurns: 20, promptTokens: 4000, charsPerToken: 4 } }];
  const captureAt = (sequence: number, terminalCause: 'completed' | null = null) => chatProjectionCapture({
    ...liveTranscriptSnapshot(LOAD_SESSION_ID, steps, { operationKind: 'message', terminalCause }), cursor: { operationId: FIXTURE_OPERATION_ID, sequence } });
  let previous = captureAt(1);
  const packets = [projectionPackets(chatSnapshotFrames(previous))];
  const offsets = { thinking: 0, answer: 0 };
  for (let index = 0; index < TOKENS; index += 1) {
    const kind = index < LOAD_THINKING_TOKENS ? 'thinking' : 'answer';
    const text = loadTokenText(kind, kind === 'thinking' ? index : index - LOAD_THINKING_TOKENS);
    steps.push({ kind, delta: { turn: 1, offset: offsets[kind], text } });
    offsets[kind] += text.length;
    const next = captureAt(index + 2);
    packets.push(projectionPackets([...encodeChatProjectionRecords(createChatUpdateRecords(previous, next), nextTransferId())]));
    previous = next;
  }
  const completed = captureAt(TOKENS + 2, 'completed');
  packets.push(projectionPackets([...encodeChatProjectionRecords(createChatUpdateRecords(previous, completed), nextTransferId())]),
    projectionPackets(singleRecordFrames(terminalRecord(completed.cursor))));
  return { packets, answerChars: offsets.answer };
}

/** Writes the snapshot at once, then every packet due at LOAD_TOKENS_PER_SECOND, as a network would batch them. */
function pace(response: http.ServerResponse, packets: readonly string[]): void {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  response.write(packets[0]);
  const started = performance.now();
  let sent = 1;
  const timer = setInterval(() => {
    const due = Math.min(packets.length, 1 + Math.floor((performance.now() - started) * LOAD_TOKENS_PER_SECOND / 1000));
    if (due > sent) response.write(packets.slice(sent, due).join(''));
    sent = Math.max(sent, due);
    if (sent < packets.length) return;
    clearInterval(timer);
    response.end();
  }, 5);
}

function serve(bundles: ReadonlyMap<string, Map<string, string>>, packets: readonly string[]): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/stream') return pace(response, packets);
    const page = bundleResponse(bundles, pathname);
    if (page === null) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': page.contentType }).end(page.body);
  });
  return new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve(server)); });
}

const MetricsSchema = z.object({ metrics: z.array(z.object({ name: z.string(), value: z.number() })) });
const ProcessInfoSchema = z.object({ processInfo: z.array(z.object({ type: z.string(), cpuTime: z.number() })) });

const cpuByType = async (chrome: HeadlessChrome): Promise<Map<string, number>> => {
  const { processInfo } = await chrome.devTools.send('SystemInfo.getProcessInfo', {}, ProcessInfoSchema);
  const totals = new Map<string, number>();
  for (const process of processInfo) totals.set(process.type, (totals.get(process.type) ?? 0) + process.cpuTime);
  return totals;
};

async function measure(chrome: HeadlessChrome, url: string) {
  const page: BrowserPage = await chrome.open(url, 'runStreamLoad');
  await page.send('Performance.enable', {}, z.object({}));
  const metrics = async () => new Map((await page.send('Performance.getMetrics', {}, MetricsSchema)).metrics.map((metric) => [metric.name, metric.value]));
  const [metricsBefore, cpuBefore] = [await metrics(), await cpuByType(chrome)];
  const result = await page.evaluate('window.runStreamLoad()', true, StreamLoadResultSchema);
  const [metricsAfter, cpuAfter] = [await metrics(), await cpuByType(chrome)];
  await page.close();
  const metricMs = (name: string) => ((metricsAfter.get(name) ?? 0) - (metricsBefore.get(name) ?? 0)) * 1000;
  const cpuMs = (type: string) => ((cpuAfter.get(type) ?? 0) - (cpuBefore.get(type) ?? 0)) * 1000;
  return { page: result, mainThreadMs: metricMs('TaskDuration'), scriptMs: metricMs('ScriptDuration'), styleMs: metricMs('RecalcStyleDuration'),
    layoutMs: metricMs('LayoutDuration'), rendererCpuMs: cpuMs('renderer'), gpuCpuMs: cpuMs('GPU'), browserCpuMs: cpuMs('browser') };
}

const percent = (part: number, whole: number) => `${(100 * part / whole).toFixed(1)}%`;

test(`${String(LOAD_TOKENS_PER_SECOND)} tokens/s through the real stream client and ChatTab: CPU per scenario`, { timeout: 300_000 }, async (t) => {
  const { packets, answerChars } = streamPackets();
  const bundles = new Map([
    ['prod', await bundleBrowserPage(path.join('dashboard', 'tests', 'chat-stream-load-page.tsx'), 'production')],
    ['dev', await bundleBrowserPage(path.join('dashboard', 'tests', 'chat-stream-load-page.tsx'), 'development')],
  ]);
  const server = await serve(bundles, packets);
  const chrome = await HeadlessChrome.launch();
  try {
    const address = server.address();
    if (address === null || typeof address === 'string') assert.fail('The page server has no TCP port.');
    const rows = [];
    const busyMs = new Map<ScenarioId, number>();
    for (const scenario of SCENARIOS) {
      const run = await measure(chrome, `http://127.0.0.1:${String(address.port)}/${scenario.build}/?${scenario.query}`);
      assert.equal(run.page.snapshots, TOKENS + 2, `${scenario.name}: every token arrives as its own committed view`);
      assert.equal(run.page.answerChars, answerChars, `${scenario.name}: the live answer holds every streamed character`);
      const lastWord = run.page.answerTail.trim().split(/\s+/u).at(-1) ?? '';
      if (scenario.rendered) assert.ok(lastWord !== '' && run.page.renderedTail.includes(lastWord), `${scenario.name}: the last token reaches the DOM (${JSON.stringify(run.page)})`);
      const wall = run.page.wallMs;
      busyMs.set(scenario.id, run.mainThreadMs);
      rows.push({
        scenario: scenario.name, 'wall s': (wall / 1000).toFixed(1), 'main thread busy': percent(run.mainThreadMs, wall),
        'busy ms/token': (run.mainThreadMs / TOKENS).toFixed(2), 'script ms': run.scriptMs.toFixed(0), 'style ms': run.styleMs.toFixed(0),
        'layout ms': run.layoutMs.toFixed(0), 'renderer CPU': percent(run.rendererCpuMs, wall), 'GPU CPU': percent(run.gpuCpuMs, wall),
        'browser CPU': percent(run.browserCpuMs, wall), 'fps': (run.page.frames * 1000 / wall).toFixed(0),
        'long tasks': `${String(run.page.longTasks)} (${run.page.longTaskMs.toFixed(0)} ms)`,
      });
    }
    for (const row of rows) t.diagnostic(JSON.stringify(row));
    // Settled history must cost almost nothing per token; only the rows on screen may be laid out and painted.
    const busyOf = (id: ScenarioId): number => {
      const busy = busyMs.get(id);
      if (busy === undefined) assert.fail(`Scenario ${id} produced no measurement.`);
      return busy;
    };
    for (const id of LONG_HISTORIES) {
      const ratio = busyOf(id) / busyOf('empty');
      assert.ok(ratio <= HISTORY_COST_CEILING, `${id} costs ${ratio.toFixed(2)}x an empty history per token`);
    }
  } finally {
    await chrome.close();
    server.close();
  }
});
