# Streamed CLI Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the five engine-backed CLI ops (`/summary`, `/command-output/analyze`, `/preset/run`, `/eval/run`, `/repo-search`) from blocking JSON POSTs to SSE streams with live progress, lock-wait feedback, and disconnect-aborts-run semantics.

**Architecture:** One shared streaming layer: `SseFrameParser` + callback-free `HttpClient.streamSse` (client side), `SseResponseWriter` + `StreamedOperationEndpoint` (server side), a three-event wire envelope (`progress` / `result` / `error`), typed progress-writer objects, and full structured error diagnostics. Result payload schemas are unchanged. JSON forms of the five endpoints are removed, not kept.

**Tech Stack:** TypeScript, Node `http` module (no new deps), zod (existing `src/lib/zod.js` wrapper), `node:test`.

**Specs:** `docs/superpowers/specs/2026-07-22-streamed-cli-transport-design.md` and `docs/superpowers/specs/2026-07-22-streamed-cli-transport-corrections-design.md`

**Test command pattern:** `npm run build:test; node .\dist\scripts\run-tests.js <file-name-filter>` (filter matches test file names). Full gate: `npm test`. Lint: `npm run lint`.

**Repo rules that bind every task:** no `as` casts, no `any`, no `!` assertions, no namespace imports, IO-boundary types via `z.infer`. Use `JsonRecordReader` for loose JSON field access (established idiom).

**Execution state:** Tasks 1-14 were completed in commits `f6290b6` through `472371e`. Do not rerun them. Execute only correction Tasks 15-19 below.

---

## File structure

| File | Responsibility |
|---|---|
| Create `src/lib/sse-frame-parser.ts` | Chunk stream → complete SSE frames `{event, data}`; drops comments |
| Modify `src/lib/http-client.ts` | `streamSse` refactored onto `SseFrameParser` (behavior unchanged) |
| Create `src/lib/operation-stream.ts` | Wire envelope: event names, error schema, lock-wait event type |
| Create `src/lib/sse-client.ts` | POST + async-generator SSE consumption, idle timeout |
| Create `src/lib/abort.ts` | `throwIfAborted` / `getAbortError` moved from `src/repo-search/engine/abort.ts` |
| Create `src/status-server/sse-response-writer.ts` | SSE response framing, heartbeat, disconnect tracking |
| Modify `src/status-server/routes/chat.ts`, `dashboard.ts` | 4 inline `writeSse` closures → `SseResponseWriter` |
| Modify `src/status-server/error-response.ts` | Split `recordServerError` (side effects) from `sendServerErrorJson` (response) |
| Create `src/status-server/routes/streamed-operation-endpoint.ts` | Shared base: parse → SSE → lock (+lock_wait) → execute → result/error → release |
| Modify `src/status-server/routes/core.ts` | Five endpoints become `StreamedOperationEndpoint` subclasses |
| Create `src/summary/progress-reporter.ts` | `SummaryProgressReporter` + `SummaryProgressEvent` |
| Delete `src/summary/progress.ts` | `logSummaryProgress` replaced by the reporter |
| Modify `src/summary/types.ts`, `request-runner.ts`, `core-runner.ts` | Thread reporter through the summary pipeline |
| Modify `src/repo-search/types.ts`, `execute.ts` | `abortSignal` threaded into `RepoSearchExecutionRequest` → engine |
| Modify `src/status-server/preset-runner.ts`, `eval.ts`, `command-output/analyzer.ts`, `engine-service.ts` | Thread `onProgress` into the summary-family execution paths |
| Modify `src/cli/status-server-api-client.ts` | Five methods consume SSE; required renderer param |
| Create `src/cli/progress-renderer.ts` | `CliProgressRenderer` (stderr lines) + `SilentProgressRenderer` |
| Modify `src/cli/dispatch.ts` + runners | Thread `stderr`, construct renderers |
| Create `tests/helpers/sse-http.ts` | `requestSse` collector + `writeSseResult` mock-server helper |

---

### Task 1: SseFrameParser + refactor `HttpClient.streamSse` onto it

**Files:**
- Create: `src/lib/sse-frame-parser.ts`
- Modify: `src/lib/http-client.ts:247-281` (inline packet parsing inside `streamSse`)
- Test: `tests/sse-frame-parser.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/sse-frame-parser.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { SseFrameParser } from '../src/lib/sse-frame-parser.js';

test('parses a single complete frame with event name', () => {
  const parser = new SseFrameParser();
  const frames = parser.push('event: progress\ndata: {"kind":"llm_start"}\n\n');
  assert.deepEqual(frames, [{ event: 'progress', data: '{"kind":"llm_start"}' }]);
});

test('defaults event name to message when absent', () => {
  const parser = new SseFrameParser();
  const frames = parser.push('data: {"a":1}\n\n');
  assert.deepEqual(frames, [{ event: 'message', data: '{"a":1}' }]);
});

test('reassembles frames split across arbitrary chunk boundaries', () => {
  const parser = new SseFrameParser();
  const full = 'event: result\ndata: {"ok":true}\n\nevent: progress\ndata: {"kind":"x"}\n\n';
  const collected = [];
  for (const char of full) {
    collected.push(...parser.push(char));
  }
  assert.deepEqual(collected, [
    { event: 'result', data: '{"ok":true}' },
    { event: 'progress', data: '{"kind":"x"}' },
  ]);
});

test('handles CRLF delimiters', () => {
  const parser = new SseFrameParser();
  const frames = parser.push('event: error\r\ndata: {"message":"boom"}\r\n\r\n');
  assert.deepEqual(frames, [{ event: 'error', data: '{"message":"boom"}' }]);
});

test('drops comment-only heartbeat frames', () => {
  const parser = new SseFrameParser();
  const frames = parser.push(': hb\n\ndata: {"x":1}\n\n');
  assert.deepEqual(frames, [{ event: 'message', data: '{"x":1}' }]);
});

test('joins multiple data lines with newline', () => {
  const parser = new SseFrameParser();
  const frames = parser.push('data: line1\ndata: line2\n\n');
  assert.deepEqual(frames, [{ event: 'message', data: 'line1\nline2' }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test; node .\dist\scripts\run-tests.js sse-frame-parser`
Expected: FAIL — cannot find module `../src/lib/sse-frame-parser.js`

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/sse-frame-parser.ts
export type SseFrame = { event: string; data: string };

/**
 * Incremental text/event-stream parser. Feed raw chunks with push(); complete
 * frames come back in order. Comment-only frames (heartbeats) are dropped.
 */
export class SseFrameParser {
  private buffer = '';

  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    let boundary = /\r?\n\r?\n/u.exec(this.buffer);
    while (boundary) {
      const packet = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
      boundary = /\r?\n\r?\n/u.exec(this.buffer);
      const frame = parsePacket(packet);
      if (frame) {
        frames.push(frame);
      }
    }
    return frames;
  }
}

function parsePacket(packet: string): SseFrame | null {
  let eventName = 'message';
  const dataLines: string[] = [];
  for (const rawLine of packet.split(/\r?\n/u)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(':')) {
      continue;
    }
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trim());
    }
  }
  if (dataLines.length === 0) {
    return null;
  }
  return { event: eventName, data: dataLines.join('\n') };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build:test; node .\dist\scripts\run-tests.js sse-frame-parser`
Expected: PASS (6 tests)

- [ ] **Step 5: Refactor `streamSse` in `src/lib/http-client.ts` onto the parser**

In `streamSse`, replace the inline buffer/boundary parsing (lines 247-281, the `let rawBuffer = ''` block) with:

```ts
        const parser = new SseFrameParser();
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          for (const frame of parser.push(chunk)) {
            if (frame.data === '[DONE]') {
              sawDone = true;
              continue;
            }
            let parsed: SseStreamPacket;
            try {
              parsed = parseJsonObjectText(frame.data);
            } catch {
              continue;
            }
            if (onData(parsed) === 'stop') {
              stoppedEarly = true;
              request.destroy();
              settleResolve();
              return;
            }
          }
        });
```

Add the import at the top of `http-client.ts`:

```ts
import { SseFrameParser } from './sse-frame-parser.js';
```

- [ ] **Step 6: Run the llama streaming regression tests**

Run: `npm run build:test; node .\dist\scripts\run-tests.js planner-streaming`
Expected: PASS (existing behavior unchanged)

- [ ] **Step 7: Commit**

```bash
git add src/lib/sse-frame-parser.ts src/lib/http-client.ts tests/sse-frame-parser.test.ts
git commit -m "feat: add SseFrameParser and refactor streamSse onto it"
```

---

### Task 2: Operation-stream envelope + SseClient

**Files:**
- Create: `src/lib/operation-stream.ts`
- Create: `src/lib/sse-client.ts`
- Test: `tests/sse-client.test.ts`

- [ ] **Step 1: Write the envelope module (pure declarations, covered by later tests)**

```ts
// src/lib/operation-stream.ts
import { z } from './zod.js';

/** Wire envelope for streamed CLI operations: exactly one result|error terminates a stream. */
export const OPERATION_STREAM_EVENTS = {
  progress: 'progress',
  result: 'result',
  error: 'error',
} as const;

export const OperationStreamErrorSchema = z.object({ message: z.string() });
export type OperationStreamError = z.infer<typeof OperationStreamErrorSchema>;

export const OPERATION_STREAM_HEARTBEAT_MS = 15_000;

export type LockWaitProgressEvent = {
  kind: 'lock_wait';
  queueLength: number;
  elapsedMs: number;
};
```

- [ ] **Step 2: Write the failing SseClient test**

```ts
// tests/sse-client.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { SseClient } from '../src/lib/sse-client.js';
import type { SseFrame } from '../src/lib/sse-frame-parser.js';
import { getAddressInfo } from './helpers/dashboard-http.js';

async function withServer(
  handler: http.RequestListener,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = getAddressInfo(server).port;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}

test('yields frames in order and completes on stream end', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: progress\ndata: {"kind":"a"}\n\n');
    res.write('event: result\ndata: {"ok":true}\n\n');
    res.end();
  }, async (baseUrl) => {
    const frames: SseFrame[] = [];
    for await (const frame of new SseClient().stream({ url: `${baseUrl}/op`, body: '{}', idleTimeoutMs: 5000 })) {
      frames.push(frame);
    }
    assert.deepEqual(frames, [
      { event: 'progress', data: '{"kind":"a"}' },
      { event: 'result', data: '{"ok":true}' },
    ]);
  });
});

test('throws HTTP-prefixed error on non-2xx status', async () => {
  await withServer((req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end('{"error":"Expected prompt."}');
  }, async (baseUrl) => {
    const iterate = async () => {
      const generator = new SseClient().stream({ url: `${baseUrl}/op`, body: '{}', idleTimeoutMs: 5000 });
      for await (const _frame of generator) { /* drain */ }
    };
    await assert.rejects(iterate, /^HTTP 400: \{"error":"Expected prompt\."\}/u);
  });
});

test('idle timeout destroys a silent stream', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: progress\ndata: {"kind":"a"}\n\n');
    // then go silent — never end
  }, async (baseUrl) => {
    const iterate = async () => {
      const generator = new SseClient().stream({ url: `${baseUrl}/op`, body: '{}', idleTimeoutMs: 200 });
      for await (const _frame of generator) { /* drain */ }
    };
    await assert.rejects(iterate, /timed out after 200 ms/u);
  });
});

test('heartbeat comments reset the idle timer without yielding frames', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let beats = 0;
    const timer = setInterval(() => {
      beats += 1;
      res.write(': hb\n\n');
      if (beats === 4) {
        clearInterval(timer);
        res.write('event: result\ndata: {"ok":true}\n\n');
        res.end();
      }
    }, 100);
  }, async (baseUrl) => {
    const frames: SseFrame[] = [];
    // 4 beats x 100ms = 400ms total, but idle gap is only ~100ms — must survive.
    for await (const frame of new SseClient().stream({ url: `${baseUrl}/op`, body: '{}', idleTimeoutMs: 250 })) {
      frames.push(frame);
    }
    assert.deepEqual(frames, [{ event: 'result', data: '{"ok":true}' }]);
  });
});

test('breaking out of iteration destroys the socket', async () => {
  let closed = false;
  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: progress\ndata: {"kind":"a"}\n\n');
    req.on('close', () => { closed = true; });
  }, async (baseUrl) => {
    for await (const _frame of new SseClient().stream({ url: `${baseUrl}/op`, body: '{}', idleTimeoutMs: 5000 })) {
      break; // consumer stops early
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(closed, true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run build:test; node .\dist\scripts\run-tests.js sse-client`
Expected: FAIL — cannot find module `../src/lib/sse-client.js`

- [ ] **Step 4: Write the implementation**

`request.setTimeout(ms)` is a socket-**inactivity** timer, which is exactly the idle
semantics we want: any bytes (heartbeats included) reset it.

```ts
// src/lib/sse-client.ts
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { SseFrameParser, type SseFrame } from './sse-frame-parser.js';

export type SseClientStreamOptions = {
  url: string;
  body: string;
  idleTimeoutMs: number;
};

type StreamItem =
  | { kind: 'frame'; frame: SseFrame }
  | { kind: 'end' }
  | { kind: 'error'; error: Error };

/** POST + text/event-stream consumption for status-server streamed operations. */
export class SseClient {
  async *stream(options: SseClientStreamOptions): AsyncGenerator<SseFrame> {
    const target = new URL(options.url);
    const requestTransport = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const items: StreamItem[] = [];
    let wakeUp: (() => void) | null = null;
    const pushItem = (item: StreamItem): void => {
      items.push(item);
      if (wakeUp) {
        const wake = wakeUp;
        wakeUp = null;
        wake();
      }
    };

    const request = requestTransport({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(options.body, 'utf8'),
        Accept: 'text/event-stream',
      },
    }, (response) => {
      const statusCode = response.statusCode || 0;
      response.setEncoding('utf8');
      if (statusCode >= 400) {
        let errorBody = '';
        response.on('data', (chunk: string) => { errorBody += chunk; });
        response.on('end', () => { pushItem({ kind: 'error', error: new Error(`HTTP ${statusCode}: ${errorBody}`) }); });
        response.on('error', () => { pushItem({ kind: 'error', error: new Error(`HTTP ${statusCode}: ${errorBody}`) }); });
        return;
      }
      const parser = new SseFrameParser();
      response.on('data', (chunk: string) => {
        for (const frame of parser.push(chunk)) {
          pushItem({ kind: 'frame', frame });
        }
      });
      response.on('end', () => pushItem({ kind: 'end' }));
      response.on('error', (error: Error) => pushItem({ kind: 'error', error }));
    });

    request.setTimeout(options.idleTimeoutMs, () => {
      request.destroy(new Error(`Operation stream timed out after ${options.idleTimeoutMs} ms of inactivity.`));
    });
    request.on('error', (error: Error) => pushItem({ kind: 'error', error }));
    request.write(options.body);
    request.end();

    try {
      for (;;) {
        while (items.length === 0) {
          await new Promise<void>((resolve) => { wakeUp = resolve; });
        }
        const item = items.shift();
        if (!item || item.kind === 'end') {
          return;
        }
        if (item.kind === 'error') {
          throw item.error;
        }
        yield item.frame;
      }
    } finally {
      request.destroy();
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run build:test; node .\dist\scripts\run-tests.js sse-client`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add src/lib/operation-stream.ts src/lib/sse-client.ts tests/sse-client.test.ts
git commit -m "feat: add operation-stream envelope and SseClient"
```

---

### Task 3: SseResponseWriter + migrate the four inline writeSse closures

**Files:**
- Create: `src/status-server/sse-response-writer.ts`
- Modify: `src/status-server/routes/chat.ts:940-950` (and the closures at ~1272, ~1510)
- Modify: `src/status-server/routes/dashboard.ts:488` (its closure)
- Test: `tests/sse-response-writer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/sse-response-writer.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { SseResponseWriter } from '../src/status-server/sse-response-writer.js';
import { SseFrameParser, type SseFrame } from '../src/lib/sse-frame-parser.js';
import { getAddressInfo } from './helpers/dashboard-http.js';

function collectFrames(baseUrl: string): Promise<SseFrame[]> {
  return new Promise((resolve, reject) => {
    const frames: SseFrame[] = [];
    const parser = new SseFrameParser();
    const request = http.request(`${baseUrl}/`, { method: 'POST' }, (response) => {
      assert.equal(response.headers['content-type'], 'text/event-stream');
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => frames.push(...parser.push(chunk)));
      response.on('end', () => resolve(frames));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end();
  });
}

test('writes framed events and ends cleanly', async () => {
  const server = http.createServer((req, res) => {
    const writer = new SseResponseWriter(req, res, { heartbeatMs: 60_000 });
    writer.open();
    writer.writeEvent('progress', { kind: 'llm_start', turn: 1 });
    writer.writeEvent('result', { ok: true });
    writer.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  try {
    const frames = await collectFrames(`http://127.0.0.1:${getAddressInfo(server).port}`);
    assert.deepEqual(frames, [
      { event: 'progress', data: '{"kind":"llm_start","turn":1}' },
      { event: 'result', data: '{"ok":true}' },
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

test('emits heartbeat comments while idle', async () => {
  const server = http.createServer((req, res) => {
    const writer = new SseResponseWriter(req, res, { heartbeatMs: 50 });
    writer.open();
    setTimeout(() => {
      writer.writeEvent('result', { ok: true });
      writer.end();
    }, 180);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  try {
    const port = getAddressInfo(server).port;
    const raw = await new Promise<string>((resolve, reject) => {
      let text = '';
      const request = http.request(`http://127.0.0.1:${port}/`, { method: 'POST' }, (response) => {
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { text += chunk; });
        response.on('end', () => resolve(text));
      });
      request.on('error', reject);
      request.end();
    });
    assert.match(raw, /: hb\n\n/u);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

test('suppresses writes after client disconnect and reports it', async () => {
  let writerRef: SseResponseWriter | null = null;
  const server = http.createServer((req, res) => {
    writerRef = new SseResponseWriter(req, res, { heartbeatMs: 60_000 });
    writerRef.open();
    writerRef.writeEvent('progress', { kind: 'a' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  try {
    const port = getAddressInfo(server).port;
    await new Promise<void>((resolve, reject) => {
      const request = http.request(`http://127.0.0.1:${port}/`, { method: 'POST' }, (response) => {
        response.on('data', () => {
          request.destroy();
          resolve();
        });
      });
      request.on('error', reject);
      request.end();
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const writer = writerRef;
    assert.ok(writer);
    assert.equal(writer.isClientDisconnected(), true);
    // Must not throw:
    writer.writeEvent('progress', { kind: 'b' });
    writer.end();
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test; node .\dist\scripts\run-tests.js sse-response-writer`
Expected: FAIL — cannot find module

- [ ] **Step 3: Write the implementation**

```ts
// src/status-server/sse-response-writer.ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { JsonSerializable } from '../lib/json-types.js';
import { OPERATION_STREAM_HEARTBEAT_MS } from '../lib/operation-stream.js';

/**
 * Owns SSE response mechanics for a single request: headers, frame framing,
 * heartbeats, and disconnect suppression. Replaces the per-route writeSse closures.
 */
export class SseResponseWriter {
  private clientDisconnected = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly heartbeatMs: number;

  constructor(
    req: IncomingMessage,
    private readonly res: ServerResponse,
    options: { heartbeatMs?: number } = {},
  ) {
    this.heartbeatMs = options.heartbeatMs ?? OPERATION_STREAM_HEARTBEAT_MS;
    req.on('close', () => {
      if (!res.writableEnded) {
        this.clientDisconnected = true;
      }
    });
  }

  open(): void {
    this.res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    this.res.write('\n');
    this.heartbeatTimer = setInterval(() => {
      this.writeRaw(': hb\n\n');
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  writeEvent(eventName: string, payload: JsonSerializable): void {
    this.writeRaw(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  isClientDisconnected(): boolean {
    return this.clientDisconnected;
  }

  end(): void {
    this.stopHeartbeat();
    if (!this.clientDisconnected && !this.res.writableEnded) {
      try {
        this.res.end();
      } catch { /* client gone */ }
    }
  }

  private writeRaw(text: string): void {
    if (this.clientDisconnected || this.res.writableEnded) {
      return;
    }
    try {
      this.res.write(text);
    } catch { /* client gone */ }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build:test; node .\dist\scripts\run-tests.js sse-response-writer`
Expected: PASS (3 tests)

- [ ] **Step 5: Migrate the four inline closures**

Exemplar — `src/status-server/routes/chat.ts:940-950` currently reads:

```ts
    let clientDisconnected = false;
    req.on('close', () => { clientDisconnected = true; });
    const writeSse = (eventName: string, payload: JsonSerializable): void => {
      if (clientDisconnected) return;
      try {
        res.write(`event: ${eventName}\n`);
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch { /* client gone */ }
    };
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('\n');
```

Replace with:

```ts
    const sseWriter = new SseResponseWriter(req, res);
    sseWriter.open();
    const writeSse = (eventName: string, payload: JsonSerializable): void => {
      sseWriter.writeEvent(eventName, payload);
    };
```

Keeping the local `writeSse` const means zero downstream call-site churn in each
route. Where the route later checks `clientDisconnected`, replace with
`sseWriter.isClientDisconnected()`. Where the route ends the response (`res.end()`
after the final SSE event), replace with `sseWriter.end()`.

Apply the identical mechanical replacement at all four sites (find them with
`event-stream` matches): `chat.ts` ~line 949, ~line 1272, ~line 1510, and
`dashboard.ts` ~line 488. Add the import to both files:

```ts
import { SseResponseWriter } from '../sse-response-writer.js';
```

- [ ] **Step 6: Run the chat/dashboard route regression tests**

Run: `npm run build:test; node .\dist\scripts\run-tests.js routes-chat; node .\dist\scripts\run-tests.js dashboard-api; node .\dist\scripts\run-tests.js repo-search-chat`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/status-server/sse-response-writer.ts src/status-server/routes/chat.ts src/status-server/routes/dashboard.ts tests/sse-response-writer.test.ts
git commit -m "feat: add SseResponseWriter and migrate inline writeSse closures"
```

---

### Task 4: Move abort helpers to lib; thread abortSignal into repo-search requests

**Files:**
- Create: `src/lib/abort.ts` (contents moved from `src/repo-search/engine/abort.ts`)
- Delete: `src/repo-search/engine/abort.ts`
- Modify: `src/repo-search/engine.ts:15`, `src/repo-search/engine/task-loop.ts:48`, `src/repo-search/engine/command-execution.ts:3` (imports)
- Modify: `src/repo-search/types.ts` (`RepoSearchExecutionRequest`)
- Modify: `src/repo-search/execute.ts` (thread to engine)

- [ ] **Step 1: Move the file**

Copy `src/repo-search/engine/abort.ts` verbatim to `src/lib/abort.ts`, delete the
original, and update the three import sites from `'./abort.js'` /
`'./engine/abort.js'` to `'../../lib/abort.js'` / `'../lib/abort.js'`
(match each file's relative depth). No behavior change.

- [ ] **Step 2: Add `abortSignal` to `RepoSearchExecutionRequest`**

In `src/repo-search/types.ts`, add to the `RepoSearchExecutionRequest` type
(after `onProgress`):

```ts
  abortSignal?: AbortSignal;
```

- [ ] **Step 3: Thread it in `src/repo-search/execute.ts`**

`executeRepoSearchRequest` builds the engine options. Find the engine invocation
(the call whose options type includes `abortSignal?: AbortSignal` — see
`src/repo-search/engine.ts:184`) and pass `abortSignal: request.abortSignal`
through. Grep `execute.ts` for the engine entry call (`runEngine` /
`executeEngine` import from `./engine.js`) and add the field to its options
object.

- [ ] **Step 4: Typecheck + repo-search regression**

Run: `npm run typecheck:test; npm run build:test; node .\dist\scripts\run-tests.js repo-search-loop; node .\dist\scripts\run-tests.js engine-command-execution`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/abort.ts src/repo-search
git rm src/repo-search/engine/abort.ts 2>$null; git add -A src/repo-search/engine
git commit -m "refactor: move abort helpers to lib and thread abortSignal into repo-search requests"
```

---

### Task 5: SummaryProgressReporter — typed events replace logSummaryProgress

**Files:**
- Create: `src/summary/progress-reporter.ts`
- Delete: `src/summary/progress.ts`
- Modify: `src/summary/types.ts` (`SummaryRequest` gains `onProgress`)
- Modify: `src/summary/request-runner.ts` (11 `logSummaryProgress` call sites)
- Modify: `src/summary/core-runner.ts` (2 call sites; `InvokeSummaryCoreOptions` gains reporter)
- Modify: `tests/summary-logging.test.ts` (rewrite stdout-line assertions to event assertions)
- Test: `tests/summary-progress-reporter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/summary-progress-reporter.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { SummaryProgressReporter, type SummaryProgressEvent } from '../src/summary/progress-reporter.js';

test('emits typed events to the sink with requestId stamped', () => {
  const events: SummaryProgressEvent[] = [];
  const reporter = new SummaryProgressReporter({
    requestId: 'req-1',
    onProgress: (event) => events.push(event),
  });
  reporter.start(120);
  reporter.configStart('load');
  reporter.configDone('llama.cpp', 'test-model');
  reporter.decisionDone('llama.cpp', false, 120);
  reporter.coreStart('llama.cpp');
  reporter.tokenizeStart('planner', 'chunk-1', 900);
  reporter.tokenizeDone('planner', 'chunk-1', 250, 'server');
  reporter.coreDone('llama.cpp');
  reporter.completed('summary');
  assert.deepEqual(events.map((event) => event.kind), [
    'start', 'config_start', 'config_done', 'decision_done', 'core_start',
    'tokenize_start', 'tokenize_done', 'core_done', 'completed',
  ]);
  assert.ok(events.every((event) => event.requestId === 'req-1'));
  assert.equal(events[0].inputChars, 120);
  assert.equal(events[2].model, 'test-model');
});

test('null sink swallows events', () => {
  const reporter = new SummaryProgressReporter({ requestId: 'req-2', onProgress: null });
  reporter.start(5);
  reporter.failed('boom');
  assert.equal(reporter.enabled, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test; node .\dist\scripts\run-tests.js summary-progress-reporter`
Expected: FAIL — cannot find module

- [ ] **Step 3: Write the implementation**

```ts
// src/summary/progress-reporter.ts
export type SummaryProgressEvent = {
  kind: 'start' | 'config_start' | 'config_done' | 'host_sync' | 'decision_done'
    | 'core_start' | 'core_done' | 'tokenize_start' | 'tokenize_done'
    | 'completed' | 'failed';
  requestId: string;
  inputChars?: number;
  source?: string;
  backend?: string;
  model?: string;
  numCtxLocal?: number;
  numCtxHost?: number;
  rawReviewRequired?: boolean;
  chars?: number;
  phase?: string;
  chunk?: string;
  promptChars?: number;
  promptTokens?: number | null;
  tokenSource?: string;
  classification?: string;
  errorMessage?: string;
};

/** Typed progress source for the summary pipeline (mirrors repo-search ProgressReporter). */
export class SummaryProgressReporter {
  private readonly onProgress: ((event: SummaryProgressEvent) => void) | null;
  private readonly requestId: string;

  constructor(options: { requestId: string; onProgress: ((event: SummaryProgressEvent) => void) | null }) {
    this.requestId = options.requestId;
    this.onProgress = options.onProgress;
  }

  get enabled(): boolean {
    return this.onProgress !== null;
  }

  private emit(event: SummaryProgressEvent): void {
    this.onProgress?.(event);
  }

  start(inputChars: number): void {
    this.emit({ kind: 'start', requestId: this.requestId, inputChars });
  }

  configStart(source: string): void {
    this.emit({ kind: 'config_start', requestId: this.requestId, source });
  }

  configDone(backend: string, model: string): void {
    this.emit({ kind: 'config_done', requestId: this.requestId, backend, model });
  }

  hostSync(numCtxLocal: number, numCtxHost: number): void {
    this.emit({ kind: 'host_sync', requestId: this.requestId, numCtxLocal, numCtxHost });
  }

  decisionDone(backend: string, rawReviewRequired: boolean, chars: number): void {
    this.emit({ kind: 'decision_done', requestId: this.requestId, backend, rawReviewRequired, chars });
  }

  coreStart(backend: string): void {
    this.emit({ kind: 'core_start', requestId: this.requestId, backend });
  }

  coreDone(backend: string): void {
    this.emit({ kind: 'core_done', requestId: this.requestId, backend });
  }

  tokenizeStart(phase: string, chunk: string, promptChars: number): void {
    this.emit({ kind: 'tokenize_start', requestId: this.requestId, phase, chunk, promptChars });
  }

  tokenizeDone(phase: string, chunk: string, promptTokens: number | null, tokenSource: string): void {
    this.emit({ kind: 'tokenize_done', requestId: this.requestId, phase, chunk, promptTokens, tokenSource });
  }

  completed(classification: string): void {
    this.emit({ kind: 'completed', requestId: this.requestId, classification });
  }

  failed(errorMessage: string): void {
    this.emit({ kind: 'failed', requestId: this.requestId, errorMessage });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build:test; node .\dist\scripts\run-tests.js summary-progress-reporter`
Expected: PASS

- [ ] **Step 5: Thread the reporter through the summary pipeline**

1. `src/summary/types.ts` — add to `SummaryRequest` (it is a server-side TS type;
   the wire body never carries this field, routes attach it after parsing):

```ts
  onProgress?: (event: SummaryProgressEvent) => void;
```

   with `import type { SummaryProgressEvent } from './progress-reporter.js';`

2. `src/summary/request-runner.ts` — construct the reporter in the constructor:

```ts
  private readonly progress: SummaryProgressReporter;
  // in constructor:
  this.progress = new SummaryProgressReporter({
    requestId: this.requestId,
    onProgress: request.onProgress ?? null,
  });
```

   Then replace each `logSummaryProgress(...)` call one-for-one:

| Old call site | New call |
|---|---|
| `:135` `start request_id=... input_chars=...` | `this.progress.start(this.inputText.length)` |
| `:189` `config_start ... source=provided` | `this.progress.configStart('provided')` |
| `:194` `config_start ... source=load` | `this.progress.configStart('load')` |
| `:202` `config_done ... backend=... model=...` | `this.progress.configDone(this.backend, this.model)` |
| `:235` `host_sync ... num_ctx_local=... num_ctx_host=...` | `this.progress.hostSync(localNumCtx, effectiveNumCtx)` |
| `:217` `decision_done ...` | `this.progress.decisionDone(this.backend, decision.RawReviewRequired, decision.CharacterCount)` |
| `:297` `core_start ...` | `this.progress.coreStart(context.backend)` |
| `:325` `core_done ...` | `this.progress.coreDone(context.backend)` |
| `:479` `failed ...` | `this.progress.failed(getErrorMessage(error))` |
| `:507` `completed ...` | `this.progress.completed(result.Classification)` |

   Remove the `logSummaryProgress` import.

3. `src/summary/core-runner.ts` — `InvokeSummaryCoreOptions` gains
   `progress?: SummaryProgressReporter`; `request-runner.ts:301` passes
   `progress: this.progress`. Replace the two `logSummaryProgress` calls
   (`core-runner.ts:359` and `:378`, the tokenize start/done lines) with
   `this.options.progress?.tokenizeStart(state.phase, state.chunkLabel, prompt.length)`
   and
   `this.options.progress?.tokenizeDone(state.phase, state.chunkLabel, promptTokenCount ?? null, tokenSource)`
   (adjust local variable names to what is in scope at each site — the values are
   already interpolated into the old log strings). Remove the import.

4. Abort support (spec: client disconnect aborts the op). Add to `SummaryRequest`
   in `src/summary/types.ts`:

```ts
  abortSignal?: AbortSignal;
```

   In `request-runner.ts`, import `throwIfAborted` from `../lib/abort.js` (moved
   there in Task 4) and check at the two phase boundaries in `runRequest()`:

```ts
  private async runRequest(): Promise<SummaryResult> {
    try {
      throwIfAborted(this.request.abortSignal);
      const context = await this.loadExecutionContext();
      const deterministicPassFailResult = await this.tryDeterministicPassFail(context);
      if (deterministicPassFailResult) {
        return deterministicPassFailResult;
      }
      throwIfAborted(this.request.abortSignal);
      return await this.invokeModelSummary(context);
    } catch (error) {
      await this.handleFailure(toError(error));
      throw error;
    }
  }
```

   (Provider-level mid-call cancellation is out of scope; these checks stop a
   disconnected run before its next model call, and the lock always frees in the
   endpoint's `finally`.)

5. Delete `src/summary/progress.ts`. Run
   `Grep logSummaryProgress src` — must return zero hits.

- [ ] **Step 6: Rewrite `tests/summary-logging.test.ts`**

That test currently captures server stdout lines. Rewrite assertions to collect
events instead: build the `SummaryRequest` it already builds, add
`onProgress: (event) => events.push(event)`, and assert the same lifecycle in
event terms, e.g.:

```ts
const kinds = events.map((event) => event.kind);
assert.deepEqual(kinds.slice(0, 2), ['start', 'config_start']);
assert.ok(kinds.includes('completed'));
```

Keep whatever non-progress assertions the file has unchanged.

- [ ] **Step 7: Run summary regressions**

Run: `npm run build:test; node .\dist\scripts\run-tests.js summary`
Expected: PASS (all summary-* files)

- [ ] **Step 8: Commit**

```bash
git add src/summary tests/summary-progress-reporter.test.ts tests/summary-logging.test.ts
git rm src/summary/progress.ts 2>$null; git add -A src/summary
git commit -m "feat: replace logSummaryProgress with typed SummaryProgressReporter"
```

---

### Task 6: Split recordServerError from sendServerErrorJson

**Files:**
- Modify: `src/status-server/error-response.ts:28-77`

- [ ] **Step 1: Refactor**

Extract everything before the final `sendJson` into `recordServerError`, which
returns the payload; `sendServerErrorJson` becomes a thin wrapper. The streamed
endpoints (Task 7) will call `recordServerError` and emit the payload as an
`error` frame instead of an HTTP error status.

```ts
export type ServerErrorPayload = {
  error: string;
  errorName: string;
  diagnosticId: string;
  diagnostic: ReturnType<typeof serializeErrorDiagnostic>;
};

export function recordServerError(
  req: IncomingMessage,
  statusCode: number,
  error: unknown,
  options: ServerErrorResponseOptions = {},
): ServerErrorPayload {
  // ...body of current sendServerErrorJson lines 35-70 unchanged...
  return {
    error: errorMessage,
    errorName: diagnostic.name,
    diagnosticId,
    diagnostic,
  };
}

export function sendServerErrorJson(
  req: IncomingMessage,
  res: ServerResponse,
  statusCode: number,
  error: unknown,
  options: ServerErrorResponseOptions = {},
): void {
  sendJson(res, statusCode, recordServerError(req, statusCode, error, options));
}
```

- [ ] **Step 2: Typecheck + existing error-path tests**

Run: `npm run typecheck:test; npm run build:test; node .\dist\scripts\run-tests.js status-route-table; node .\dist\scripts\run-tests.js dashboard-api`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/status-server/error-response.ts
git commit -m "refactor: split recordServerError from sendServerErrorJson"
```

---

### Task 7: StreamedOperationEndpoint base + convert /summary (first E2E)

**Files:**
- Create: `src/status-server/routes/streamed-operation-endpoint.ts`
- Modify: `src/status-server/routes/core.ts` (`SummaryEndpoint`, lines 948-1009)
- Create: `tests/helpers/sse-http.ts`
- Test: `tests/streamed-summary-endpoint.test.ts`

- [ ] **Step 1: Write the test helper**

```ts
// tests/helpers/sse-http.ts
import http from 'node:http';
import { SseFrameParser, type SseFrame } from '../../src/lib/sse-frame-parser.js';
import { parseJsonValueText } from '../../src/lib/json.js';
import type { JsonObject, JsonSerializable } from '../../src/lib/json-types.js';
import { asObject } from './dashboard-http.js';

export type CollectedSseResponse = {
  statusCode: number;
  frames: SseFrame[];
  progress: JsonObject[];
  result: JsonObject | null;
  errorMessage: string | null;
  rawBody: string;
};

/** POST a body and collect the full SSE stream (or a plain JSON error response). */
export function requestSse(url: string, options: { body: JsonSerializable; timeoutMs?: number }): Promise<CollectedSseResponse> {
  return new Promise((resolve, reject) => {
    const bodyText = JSON.stringify(options.body);
    const collected: CollectedSseResponse = {
      statusCode: 0, frames: [], progress: [], result: null, errorMessage: null, rawBody: '',
    };
    const parser = new SseFrameParser();
    const request = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyText, 'utf8') },
    }, (response) => {
      collected.statusCode = response.statusCode || 0;
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        collected.rawBody += chunk;
        for (const frame of parser.push(chunk)) {
          collected.frames.push(frame);
          const data = asObject(parseJsonValueText(frame.data));
          if (frame.event === 'progress') collected.progress.push(data);
          if (frame.event === 'result') collected.result = data;
          if (frame.event === 'error') collected.errorMessage = String(data.message || '');
        }
      });
      response.on('end', () => resolve(collected));
      response.on('error', reject);
    });
    request.setTimeout(options.timeoutMs ?? 15_000, () => request.destroy(new Error('requestSse timed out')));
    request.on('error', reject);
    request.write(bodyText);
    request.end();
  });
}

/** For CLI-facing mock servers: reply to a streamed-op POST with a minimal valid stream. */
export function writeSseResult(res: http.ServerResponse, payload: JsonSerializable, progressEvents: JsonSerializable[] = []): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('\n');
  for (const event of progressEvents) {
    res.write(`event: progress\ndata: ${JSON.stringify(event)}\n\n`);
  }
  res.write(`event: result\ndata: ${JSON.stringify(payload)}\n\n`);
  res.end();
}
```

- [ ] **Step 2: Write the failing E2E test**

Reuse the env-setup pattern from `tests/repo-search-status-server.test.ts:76-102`
(tempRoot, env backup, `startStatusServer({ disableManagedLlamaStartup: true })`).
The summary mock backend is selected with `backend: 'mock'` in the request body
(see `tests/summary-mock-provider.test.ts` for the established mock usage).

```ts
// tests/streamed-summary-endpoint.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startStatusServer } from '../src/status-server/index.js';
import { closeRuntimeDatabase } from '../src/state/runtime-db.js';
import { SummaryResultSchema } from '../src/summary/types.js';
import { requestSse } from './helpers/sse-http.js';
import { getAddressInfo } from './helpers/dashboard-http.js';

type ServerHarness = { baseUrl: string; close: () => Promise<void> };

async function startHarness(namePrefix: string): Promise<ServerHarness> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), namePrefix));
  const previousCwd = process.cwd();
  fs.writeFileSync(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'siftkit', version: '0.1.0' }), 'utf8');
  process.chdir(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const envBackup: Record<string, string | undefined> = {
    sift_kit_status: process.env.sift_kit_status,
    SIFTKIT_STATUS_PATH: process.env.SIFTKIT_STATUS_PATH,
    SIFTKIT_CONFIG_PATH: process.env.SIFTKIT_CONFIG_PATH,
    SIFTKIT_STATUS_HOST: process.env.SIFTKIT_STATUS_HOST,
    SIFTKIT_STATUS_PORT: process.env.SIFTKIT_STATUS_PORT,
  };
  process.env.sift_kit_status = statusPath;
  process.env.SIFTKIT_STATUS_PATH = statusPath;
  process.env.SIFTKIT_CONFIG_PATH = path.join(tempRoot, '.siftkit', 'config.json');
  process.env.SIFTKIT_STATUS_HOST = '127.0.0.1';
  process.env.SIFTKIT_STATUS_PORT = '0';
  const server = startStatusServer({ disableManagedLlamaStartup: true, terminalMetadataIdleDelayMs: 50 });
  await server.startupPromise;
  const baseUrl = `http://127.0.0.1:${getAddressInfo(server).port}`;
  return {
    baseUrl,
    async close() {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
      process.chdir(previousCwd);
      closeRuntimeDatabase();
      for (const [key, value] of Object.entries(envBackup)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

test('summary streams progress frames before a schema-valid result frame', async () => {
  const harness = await startHarness('siftkit-streamed-summary-');
  try {
    const response = await requestSse(`${harness.baseUrl}/summary`, {
      body: { question: 'what is in the text?', inputText: 'alpha beta gamma', backend: 'mock' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.errorMessage, null);
    assert.ok(response.result, response.rawBody);
    const firstResultIndex = response.frames.findIndex((frame) => frame.event === 'result');
    const firstProgressIndex = response.frames.findIndex((frame) => frame.event === 'progress');
    assert.ok(firstProgressIndex >= 0, 'expected at least one progress frame');
    assert.ok(firstProgressIndex < firstResultIndex, 'progress must precede result');
    const parsed = SummaryResultSchema.parse(response.result);
    assert.equal(parsed.WasSummarized, true);
  } finally {
    await harness.close();
  }
});

test('malformed body gets a plain HTTP 400 before SSE opens', async () => {
  const harness = await startHarness('siftkit-streamed-summary-400-');
  try {
    const response = await requestSse(`${harness.baseUrl}/summary`, { body: { inputText: 'no question' } });
    assert.equal(response.statusCode, 400);
    assert.equal(response.frames.length, 0);
    assert.match(response.rawBody, /Expected question and inputText/u);
  } finally {
    await harness.close();
  }
});

test('engine failure surfaces as an error frame, not an HTTP error', async () => {
  const harness = await startHarness('siftkit-streamed-summary-err-');
  try {
    // mock backend rejects oversized input loudly (see SummaryRequestRunner.rejectOversizedMockInput)
    const response = await requestSse(`${harness.baseUrl}/summary`, {
      body: { question: 'q', inputText: 'x'.repeat(600_000), backend: 'mock' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.result, null);
    assert.match(String(response.errorMessage), /maximum/u);
  } finally {
    await harness.close();
  }
});

test('queued second request receives lock_wait progress', async () => {
  const harness = await startHarness('siftkit-streamed-summary-lock-');
  try {
    // Hold the lock with a slow repo-search mock command (JSON endpoint is gone
    // by Task 8; until then repo-search still occupies the same lock via SSE or
    // JSON — use a second summary here to stay self-contained).
    const slowRequest = requestSse(`${harness.baseUrl}/summary`, {
      body: { question: 'q1', inputText: `slow ${'y'.repeat(50)}`, backend: 'mock' },
    });
    // Immediately queue another one; with mock backend both are fast, so instead
    // assert the well-known case: when the first finishes instantly the second
    // may see zero lock_wait frames. Force overlap via Promise.all and accept
    // either zero or more lock_wait frames, but require both to succeed:
    const [first, second] = await Promise.all([
      slowRequest,
      requestSse(`${harness.baseUrl}/summary`, { body: { question: 'q2', inputText: 'z text', backend: 'mock' } }),
    ]);
    assert.ok(first.result);
    assert.ok(second.result);
    for (const event of second.progress.filter((p) => p.kind === 'lock_wait')) {
      assert.equal(typeof event.queueLength, 'number');
    }
  } finally {
    await harness.close();
  }
});
```

(The deterministic lock_wait assertion — a queued caller with a genuinely slow
holder — lands in Task 8's repo-search test where `mockCommandResults.delayMs`
gives reliable slowness.)

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run build:test; node .\dist\scripts\run-tests.js streamed-summary-endpoint`
Expected: FAIL — `/summary` still answers plain JSON, so `frames.length === 0` and `result === null`

- [ ] **Step 4: Write StreamedOperationEndpoint**

```ts
// src/status-server/routes/streamed-operation-endpoint.ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { JsonObject, JsonSerializable } from '../../lib/json-types.js';
import { OPERATION_STREAM_EVENTS } from '../../lib/operation-stream.js';
import { recordServerError } from '../error-response.js';
import { SseResponseWriter } from '../sse-response-writer.js';
import { parseJsonBody, readBody, sendJson } from '../http-utils.js';
import {
  acquireModelRequestWithWait,
  ensureActivePresetReadyForModelRequest,
  getModelRequestQueueDiagnostics,
  releaseModelRequest,
} from '../server-ops.js';
import type { RouteEndpoint, RouteMatch, ServerContext } from './types.js';

const LOCK_WAIT_EMIT_INTERVAL_MS = 2_000;

export type ParsedStreamedRequest<TParsed> =
  | { ok: true; value: TParsed }
  | { ok: false; error: string };

export type StreamedOperationStream = {
  emitProgress(event: JsonSerializable): void;
  abortSignal: AbortSignal;
};

/**
 * Shared flow for streamed CLI operations:
 * parse (400 before SSE) -> open SSE -> lock (lock_wait progress while queued)
 * -> preset readiness -> execute -> result|error frame -> release lock, end stream.
 */
export abstract class StreamedOperationEndpoint<TParsed> implements RouteEndpoint {
  protected abstract readonly lockKind: string;
  protected abstract readonly taskKind: 'summary' | 'repo-search';

  protected abstract parseRequest(parsedBody: JsonObject, ctx: ServerContext): ParsedStreamedRequest<TParsed>;

  protected abstract execute(
    ctx: ServerContext,
    parsed: TParsed,
    stream: StreamedOperationStream,
  ): Promise<JsonSerializable>;

  /** Hook for per-op failure bookkeeping (repo-search admission marking). Default: none. */
  protected onOperationFailed(_parsed: TParsed, _errorMessage: string): void {}

  async handle(ctx: ServerContext, req: IncomingMessage, res: ServerResponse, _match: RouteMatch): Promise<void> {
    let parsedBody: JsonObject;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return;
    }
    const parsed = this.parseRequest(parsedBody, ctx);
    if (!parsed.ok) {
      sendJson(res, 400, { error: parsed.error });
      return;
    }

    const writer = new SseResponseWriter(req, res);
    writer.open();
    const abortController = new AbortController();
    let terminalFrameSent = false;
    req.on('close', () => {
      if (!terminalFrameSent) {
        abortController.abort(new Error('Client disconnected.'));
      }
    });

    const lockWaitStartedAt = Date.now();
    const lockWaitTimer = setInterval(() => {
      writer.writeEvent(OPERATION_STREAM_EVENTS.progress, {
        kind: 'lock_wait',
        queueLength: getModelRequestQueueDiagnostics(ctx).queueLength ?? 0,
        elapsedMs: Date.now() - lockWaitStartedAt,
      });
    }, LOCK_WAIT_EMIT_INTERVAL_MS);
    lockWaitTimer.unref?.();
    const modelRequestLock = await acquireModelRequestWithWait(ctx, this.lockKind, req, res);
    clearInterval(lockWaitTimer);
    if (!modelRequestLock) {
      const message = 'Timed out waiting for model request queue.';
      this.onOperationFailed(parsed.value, message);
      writer.writeEvent(OPERATION_STREAM_EVENTS.error, { message, modelRequests: getModelRequestQueueDiagnostics(ctx) });
      writer.end();
      return;
    }

    try {
      try {
        await ensureActivePresetReadyForModelRequest(ctx);
      } catch (error) {
        const payload = recordServerError(req, 503, error, { taskKind: this.taskKind });
        this.onOperationFailed(parsed.value, payload.error);
        terminalFrameSent = true;
        writer.writeEvent(OPERATION_STREAM_EVENTS.error, { message: payload.error, diagnosticId: payload.diagnosticId });
        return;
      }
      const result = await this.execute(ctx, parsed.value, {
        emitProgress: (event) => writer.writeEvent(OPERATION_STREAM_EVENTS.progress, event),
        abortSignal: abortController.signal,
      });
      terminalFrameSent = true;
      writer.writeEvent(OPERATION_STREAM_EVENTS.result, result);
    } catch (error) {
      const payload = recordServerError(req, 500, error, { taskKind: this.taskKind });
      this.onOperationFailed(parsed.value, payload.error);
      terminalFrameSent = true;
      writer.writeEvent(OPERATION_STREAM_EVENTS.error, { message: payload.error, diagnosticId: payload.diagnosticId });
    } finally {
      releaseModelRequest(ctx, modelRequestLock.token);
      writer.end();
    }
  }
}
```

Adjust the imports to the actual export locations in this repo:
`parseJsonBody`/`readBody`/`sendJson` and the server-ops functions are already
imported by `core.ts` — mirror those import paths. `getModelRequestQueueDiagnostics`
returns a diagnostics object; read `queueLength` via `JsonRecordReader` if it is
not a typed field (`new JsonRecordReader(diagnostics).number('queueLength') ?? 0`).
If `RouteEndpoint`/`RouteMatch`/`ServerContext` live elsewhere than
`./types.js`, mirror `core.ts`'s own imports.

- [ ] **Step 5: Convert `SummaryEndpoint` in core.ts**

Replace the class body (`core.ts:948-1009`) with:

```ts
type ParsedSummaryRoute = NonNullable<ReturnType<typeof parseSummaryRequest>>;

class SummaryEndpoint extends StreamedOperationEndpoint<ParsedSummaryRoute> {
  protected readonly lockKind = 'summary';
  protected readonly taskKind = 'summary';

  protected parseRequest(parsedBody: JsonObject): ParsedStreamedRequest<ParsedSummaryRoute> {
    const summaryRequest = parseSummaryRequest(parsedBody);
    if (!summaryRequest) {
      return { ok: false, error: 'Expected question and inputText.' };
    }
    return { ok: true, value: summaryRequest };
  }

  protected async execute(
    ctx: ServerContext,
    summaryRequest: ParsedSummaryRoute,
    stream: StreamedOperationStream,
  ): Promise<JsonSerializable> {
    const { configPath } = ctx;
    return ctx.engineService.summarize({
      question: summaryRequest.question,
      inputText: summaryRequest.inputText,
      format: summaryRequest.format,
      policyProfile: summaryRequest.policyProfile,
      backend: summaryRequest.backend,
      model: summaryRequest.model,
      sourceKind: summaryRequest.sourceKind,
      commandExitCode: summaryRequest.commandExitCode,
      requestTimeoutSeconds: summaryRequest.requestTimeoutSeconds,
      timing: summaryRequest.timing,
      promptPrefix: summaryRequest.promptPrefix,
      llamaCppOverrides: summaryRequest.llamaCppOverrides,
      statusBackendUrl: `${ctx.getServiceBaseUrl()}/status`,
      config: readConfig(configPath),
      abortSignal: stream.abortSignal,
      onProgress(event) {
        stream.emitProgress(event);
      },
    });
  }
}
```

`SummaryResult` satisfies `JsonSerializable` — if TS complains about the return
type, type `execute`'s promise as the concrete result and let the base class
accept it via a generic result type parameter instead of widening (add a second
generic `TResult extends JsonSerializable` to `StreamedOperationEndpoint` if
needed; do NOT cast).

- [ ] **Step 6: Run the E2E test**

Run: `npm run build:test; node .\dist\scripts\run-tests.js streamed-summary-endpoint`
Expected: PASS (4 tests)

- [ ] **Step 7: Commit**

```bash
git add src/status-server/routes/streamed-operation-endpoint.ts src/status-server/routes/core.ts tests/helpers/sse-http.ts tests/streamed-summary-endpoint.test.ts
git commit -m "feat: add StreamedOperationEndpoint and convert /summary to SSE"
```

---

### Task 8: Convert /repo-search to SSE

**Files:**
- Modify: `src/status-server/routes/core.ts` (`RepoSearchEndpoint`, lines 865-946)
- Test: `tests/streamed-repo-search-endpoint.test.ts`

- [ ] **Step 1: Write the failing test** (reuse `startHarness` — export it from
`tests/streamed-summary-endpoint.test.ts` into `tests/helpers/streamed-op-harness.ts`
and import it in both test files; move, don't duplicate)

```ts
// tests/streamed-repo-search-endpoint.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { RepoSearchExecutionResultSchema } from '../src/repo-search/types.js';
import { requestSse } from './helpers/sse-http.js';
import { startHarness } from './helpers/streamed-op-harness.js';

const REPO_SEARCH_BODY = {
  prompt: 'find x',
  model: 'mock-model',
  maxTurns: 2,
  availableModels: ['mock-model'],
  mockResponses: [
    '{"action":"git","command":"git grep -n \\"x\\" src"}',
    '{"action":"finish","output":"done"}',
  ],
  mockCommandResults: {
    'git grep -n "x" src': { exitCode: 0, stdout: 'src/example.ts:1:x', stderr: '', delayMs: 400 },
  },
};

test('repo-search streams tool progress then a schema-valid result', async () => {
  const harness = await startHarness('siftkit-streamed-rs-');
  try {
    const response = await requestSse(`${harness.baseUrl}/repo-search`, {
      body: { ...REPO_SEARCH_BODY, repoRoot: process.cwd() },
    });
    assert.equal(response.statusCode, 200);
    assert.ok(response.result, response.rawBody);
    const parsed = RepoSearchExecutionResultSchema.parse(response.result);
    assert.equal(parsed.scorecard.tasks[0].finalOutput, 'done');
    const kinds = response.progress.map((event) => String(event.kind || ''));
    assert.ok(kinds.includes('tool_start'), kinds.join(','));
    assert.ok(kinds.includes('tool_result'), kinds.join(','));
    assert.ok(!kinds.includes('thinking'), 'thinking frames must be filtered');
    assert.ok(!kinds.includes('answer'), 'answer frames must be filtered');
  } finally {
    await harness.close();
  }
});

test('queued repo-search sees lock_wait progress while a slow run holds the lock', async () => {
  const harness = await startHarness('siftkit-streamed-rs-lock-');
  try {
    const slowBody = {
      ...REPO_SEARCH_BODY,
      repoRoot: process.cwd(),
      mockCommandResults: {
        'git grep -n "x" src': { exitCode: 0, stdout: 'src/example.ts:1:x', stderr: '', delayMs: 3000 },
      },
    };
    const holder = requestSse(`${harness.baseUrl}/repo-search`, { body: slowBody, timeoutMs: 20_000 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const queued = await requestSse(`${harness.baseUrl}/repo-search`, {
      body: {
        prompt: 'queued', repoRoot: process.cwd(), model: 'mock-model', maxTurns: 1,
        availableModels: ['mock-model'],
        mockResponses: ['{"action":"finish","output":"queued done"}'],
        mockCommandResults: {},
      },
      timeoutMs: 20_000,
    });
    const holderResponse = await holder;
    assert.ok(holderResponse.result);
    assert.ok(queued.result);
    const lockWaits = queued.progress.filter((event) => event.kind === 'lock_wait');
    assert.ok(lockWaits.length >= 1, 'expected lock_wait progress while queued');
  } finally {
    await harness.close();
  }
});

test('client disconnect aborts the run and frees the lock', async () => {
  const harness = await startHarness('siftkit-streamed-rs-abort-');
  try {
    const http = await import('node:http');
    const slowBody = JSON.stringify({
      ...REPO_SEARCH_BODY,
      repoRoot: process.cwd(),
      mockCommandResults: {
        'git grep -n "x" src': { exitCode: 0, stdout: 'x', stderr: '', delayMs: 10_000 },
      },
    });
    // Start a run, then destroy the socket mid-stream.
    await new Promise<void>((resolve, reject) => {
      const request = http.default.request(`${harness.baseUrl}/repo-search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(slowBody, 'utf8') },
      }, (response) => {
        response.once('data', () => {
          request.destroy();
          resolve();
        });
      });
      request.on('error', reject);
      request.write(slowBody);
      request.end();
    });
    // The lock must free promptly: a follow-up fast run completes well before the 10s mock delay.
    const startedAt = Date.now();
    const followUp = await requestSse(`${harness.baseUrl}/repo-search`, {
      body: {
        prompt: 'after abort', repoRoot: process.cwd(), model: 'mock-model', maxTurns: 1,
        availableModels: ['mock-model'],
        mockResponses: ['{"action":"finish","output":"after abort done"}'],
        mockCommandResults: {},
      },
      timeoutMs: 20_000,
    });
    assert.ok(followUp.result, followUp.rawBody);
    assert.ok(Date.now() - startedAt < 8_000, 'lock was not freed by the aborted run');
  } finally {
    await harness.close();
  }
});

test('sanity-check failure surfaces as an error frame', async () => {
  const harness = await startHarness('siftkit-streamed-rs-sanity-');
  try {
    const duplicated = ['line one.', 'line two.', 'line three.', '', 'Conclusion: done.'];
    const body = {
      prompt: 'find duplicated response', repoRoot: process.cwd(), model: 'mock-model', maxTurns: 8,
      availableModels: ['mock-model'],
      mockResponses: [
        ...['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map((term) => JSON.stringify({ action: 'git', command: `git grep -n "${term}" src` })),
        JSON.stringify({ action: 'finish', output: [...duplicated, ...duplicated].join('\n') }),
      ],
      mockCommandResults: Object.fromEntries(['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map((term, index) => [
        `git grep -n "${term}" src`,
        { exitCode: 0, stdout: `src/${index}.ts:1:${term}`, stderr: '' },
      ])),
    };
    const response = await requestSse(`${harness.baseUrl}/repo-search`, { body, timeoutMs: 20_000 });
    assert.equal(response.result, null);
    assert.match(String(response.errorMessage), /sanity check failed/iu);
  } finally {
    await harness.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test; node .\dist\scripts\run-tests.js streamed-repo-search-endpoint`
Expected: FAIL — endpoint still answers JSON

- [ ] **Step 3: Convert `RepoSearchEndpoint`**

Replace the class (`core.ts:865-946`) with:

```ts
type ParsedRepoSearchRoute = {
  parsedBody: JsonObject;
  repoSearchRequest: RepoSearchRouteRequest;
  admission: RepoSearchAdmissionRecord;
};

class RepoSearchEndpoint extends StreamedOperationEndpoint<ParsedRepoSearchRoute> {
  protected readonly lockKind = 'repo_search';
  protected readonly taskKind = 'repo-search';

  protected parseRequest(parsedBody: JsonObject): ParsedStreamedRequest<ParsedRepoSearchRoute> {
    const repoSearchRequest = parseRepoSearchRequest(parsedBody);
    if (!repoSearchRequest) {
      return { ok: false, error: 'Expected prompt.' };
    }
    const admission = createRepoSearchAdmissionRecord(repoSearchRequest);
    upsertRepoSearchAdmission(admission);
    return { ok: true, value: { parsedBody, repoSearchRequest, admission } };
  }

  protected onOperationFailed(parsed: ParsedRepoSearchRoute, errorMessage: string): void {
    markRepoSearchAdmissionFailed(parsed.admission, errorMessage);
  }

  protected async execute(
    ctx: ServerContext,
    parsed: ParsedRepoSearchRoute,
    stream: StreamedOperationStream,
  ): Promise<JsonSerializable> {
    const { parsedBody, repoSearchRequest, admission } = parsed;
    const reader = new JsonRecordReader(parsedBody);
    if (Number.isFinite(Number(parsedBody.simulateWorkMs)) && Number(parsedBody.simulateWorkMs) > 0) {
      await sleep(Math.max(1, Math.trunc(Number(parsedBody.simulateWorkMs))));
    }
    const config = readConfig(ctx.configPath);
    const result = await ctx.engineService.executeRepoSearch({
      taskKind: 'repo-search',
      prompt: repoSearchRequest.prompt,
      requestId: admission.requestId,
      startedAtUtc: admission.startedAtUtc,
      promptPrefix: reader.optionalString('promptPrefix'),
      repoRoot: admission.repoRoot,
      statusBackendUrl: `${ctx.getServiceBaseUrl()}/status`,
      config,
      allowedTools: Array.isArray(parsedBody.allowedTools) ? parsedBody.allowedTools.map((value) => String(value)) : undefined,
      includeAgentsMd: resolveEffectiveAgentsMd(config, null),
      includeRepoFileListing: resolveEffectiveRepoFileListing(config, null),
      model: reader.optionalString('model'),
      maxTurns: reader.number('maxTurns') ?? undefined,
      logFile: reader.optionalString('logFile'),
      availableModels: Array.isArray(parsedBody.availableModels) ? parsedBody.availableModels.map((v) => String(v)) : undefined,
      mockResponses: Array.isArray(parsedBody.mockResponses) ? parsedBody.mockResponses.map((v) => String(v)) : undefined,
      mockCommandResults: normalizeRepoSearchMockCommandResults(parsedBody.mockCommandResults),
      abortSignal: stream.abortSignal,
      onProgress(event: RepoSearchProgressEvent) {
        if (event.kind === 'tool_start') {
          const body = buildRepoSearchProgressLogBody(event);
          if (body) {
            serverLogger.emitBody('rs', admission.requestId, body);
          }
        }
        if (event.kind === 'thinking' || event.kind === 'answer') {
          return; // high-frequency chat-oriented events; not part of the CLI stream
        }
        stream.emitProgress(event);
      },
    });
    RepoSearchResponseSanityChecker.assertSafeToSend(result);
    return result;
  }
}
```

All referenced helpers (`parseRepoSearchRequest`, `createRepoSearchAdmissionRecord`,
`upsertRepoSearchAdmission`, `markRepoSearchAdmissionFailed`, `sleep`, `readConfig`,
`resolveEffectiveAgentsMd`, `resolveEffectiveRepoFileListing`,
`normalizeRepoSearchMockCommandResults`, `serverLogger`,
`buildRepoSearchProgressLogBody`, `RepoSearchResponseSanityChecker`) are already
imported in `core.ts` for the old class — keep those imports.
`RepoSearchProgressEvent` events serialize as `JsonSerializable` (all fields are
primitives) — if TS objects, emit via a plain object spread of the event.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build:test; node .\dist\scripts\run-tests.js streamed-repo-search-endpoint`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/status-server/routes/core.ts tests/streamed-repo-search-endpoint.test.ts tests/helpers/streamed-op-harness.ts tests/streamed-summary-endpoint.test.ts
git commit -m "feat: convert /repo-search to SSE with abort-on-disconnect"
```

---

### Task 9: Convert /command-output/analyze, /preset/run, /eval/run

**Files:**
- Modify: `src/status-server/routes/core.ts` (`CommandOutputAnalyzeEndpoint:683`, `PresetRunEndpoint:760`, `EvalRunEndpoint:818`)
- Modify: `src/command-output/types.ts` (`CommandOutputAnalyzeRequest` gains `onProgress`), `src/command-output/analyzer.ts:170` (forward into `summarizeRequest`)
- Modify: `src/status-server/preset-runner.ts` (`PresetRunOptions` gains `onProgress`; forward into `summarize` / `executeRepoSearch` calls at lines 164, 208, 237)
- Modify: `src/status-server/eval.ts` (`runEvaluation` gains `onProgress` param; forward at lines 86, 122), `src/status-server/engine-service.ts` (`runEvaluation` signature)
- Test: `tests/streamed-op-endpoints.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/streamed-op-endpoints.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { CommandOutputAnalyzeResultSchema, PresetRunResultSchema } from '../src/command-output/types.js';
import { requestSse } from './helpers/sse-http.js';
import { startHarness } from './helpers/streamed-op-harness.js';

test('command-output/analyze streams progress and a schema-valid result', async () => {
  const harness = await startHarness('siftkit-streamed-cmd-');
  try {
    const response = await requestSse(`${harness.baseUrl}/command-output/analyze`, {
      body: {
        outputKind: 'command',
        exitCode: 0,
        combinedText: 'all tests passed',
        question: 'did it pass?',
        backend: 'mock',
      },
    });
    assert.equal(response.statusCode, 200);
    assert.ok(response.result, response.rawBody);
    CommandOutputAnalyzeResultSchema.parse(response.result);
    assert.ok(response.progress.length >= 1, 'expected forwarded summary progress');
  } finally {
    await harness.close();
  }
});

test('preset/run streams a schema-valid result for a summary preset', async () => {
  const harness = await startHarness('siftkit-streamed-preset-');
  try {
    // 'default-summary' style preset ids come from the default config presets;
    // pick the first summary preset via /preset/list (plain JSON, unchanged).
    const { requestJson } = await import('./helpers/dashboard-http.js');
    const list = await requestJson(`${harness.baseUrl}/preset/list`);
    const { asObjectArray } = await import('./helpers/dashboard-http.js');
    const presets = asObjectArray(list.body.presets);
    const summaryPreset = presets.find((preset) => preset.presetKind === 'summary');
    assert.ok(summaryPreset, JSON.stringify(list.body));
    const response = await requestSse(`${harness.baseUrl}/preset/run`, {
      body: {
        presetId: String(summaryPreset.id),
        question: 'did it pass?',
        inputText: 'output text here',
        backend: 'mock',
      },
    });
    assert.equal(response.statusCode, 200);
    assert.ok(response.result, response.rawBody);
    PresetRunResultSchema.parse(response.result);
  } finally {
    await harness.close();
  }
});

test('eval/run answers over SSE (error frame acceptable without fixtures)', async () => {
  const harness = await startHarness('siftkit-streamed-eval-');
  try {
    const response = await requestSse(`${harness.baseUrl}/eval/run`, {
      body: { RealLogPath: [], Backend: 'mock' },
      timeoutMs: 20_000,
    });
    assert.equal(response.statusCode, 200);
    // Terminal frame required either way — never a hung or empty stream:
    assert.ok(response.result !== null || response.errorMessage !== null, response.rawBody);
  } finally {
    await harness.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test; node .\dist\scripts\run-tests.js streamed-op-endpoints`
Expected: FAIL — endpoints still answer JSON

- [ ] **Step 3: Thread onProgress through the summary-family paths**

1. `src/command-output/types.ts` — `CommandOutputAnalyzeRequest` gains:

```ts
  onProgress?: (event: SummaryProgressEvent) => void;
  abortSignal?: AbortSignal;
```

   (`import type { SummaryProgressEvent } from '../summary/progress-reporter.js';`)
   `analyzer.ts:170` forwards both into
   `summarizeRequest({ ..., onProgress: request.onProgress, abortSignal: request.abortSignal })`,
   and the `CommandOutputAnalyzeEndpoint` below passes `abortSignal: stream.abortSignal`.

2. `src/status-server/preset-runner.ts` — `PresetRunOptions` gains:

```ts
type PresetRunOptions = {
  statusBackendUrl: string;
  onSummaryProgress?: (event: SummaryProgressEvent) => void;
  onRepoSearchProgress?: (event: RepoSearchProgressEvent) => void;
};
```

   `runSummaryPreset` passes `onProgress: options.onSummaryProgress` into
   `engineService.summarize`; `runChatPreset` and `runRepoSearchPreset` pass
   `onProgress: options.onRepoSearchProgress` into `engineService.executeRepoSearch`.

3. `src/status-server/eval.ts` — `runEvaluation(request, onProgress?)`:

```ts
export async function runEvaluation(
  request: EvalRequest,
  onProgress?: (event: SummaryProgressEvent) => void,
): Promise<EvaluationResult> {
```

   forward `onProgress` into both `summarizeRequest` calls (lines 86 and 122).
   `src/status-server/engine-service.ts` mirrors:
   `runEvaluation(request, onProgress?)` → `runEvaluation(request, onProgress)`.

- [ ] **Step 4: Convert the three endpoints**

Each becomes a `StreamedOperationEndpoint` subclass, same shape as `SummaryEndpoint`
(Task 7 Step 5). Complete code:

```ts
type ParsedCommandOutputRoute = { parsedBody: JsonObject };

class CommandOutputAnalyzeEndpoint extends StreamedOperationEndpoint<ParsedCommandOutputRoute> {
  protected readonly lockKind = 'summary';
  protected readonly taskKind = 'summary';

  protected parseRequest(parsedBody: JsonObject): ParsedStreamedRequest<ParsedCommandOutputRoute> {
    return { ok: true, value: { parsedBody } };
  }

  protected async execute(ctx: ServerContext, parsed: ParsedCommandOutputRoute, stream: StreamedOperationStream): Promise<JsonSerializable> {
    const { parsedBody } = parsed;
    const reader = new JsonRecordReader(parsedBody);
    return ctx.engineService.analyzeCommandOutput({
      outputKind: normalizeCommandOutputKind(parsedBody.outputKind),
      exitCode: reader.number('exitCode') ?? 1,
      combinedText: typeof parsedBody.combinedText === 'string' ? parsedBody.combinedText : '',
      commandText: reader.optionalString('commandText'),
      question: reader.optionalString('question'),
      riskLevel: normalizeCommandOutputRiskLevel(parsedBody.riskLevel),
      reducerProfile: normalizeCommandOutputReducerProfile(parsedBody.reducerProfile),
      format: parsedBody.format === 'json' ? 'json' : 'text',
      policyProfile: normalizeSummaryPolicyProfile(parsedBody.policyProfile),
      backend: parseOptionalSummaryProvider(reader.optionalString('backend')),
      model: reader.optionalString('model'),
      noSummarize: parsedBody.noSummarize === true,
      config: readConfig(ctx.configPath),
      abortSignal: stream.abortSignal,
      onProgress(event) {
        stream.emitProgress(event);
      },
    });
  }
}

type ParsedPresetRunRoute = { parsedBody: JsonObject };

class PresetRunEndpoint extends StreamedOperationEndpoint<ParsedPresetRunRoute> {
  protected readonly lockKind = 'summary';
  protected readonly taskKind = 'summary';

  protected parseRequest(parsedBody: JsonObject): ParsedStreamedRequest<ParsedPresetRunRoute> {
    return { ok: true, value: { parsedBody } };
  }

  protected async execute(ctx: ServerContext, parsed: ParsedPresetRunRoute, stream: StreamedOperationStream): Promise<JsonSerializable> {
    const { parsedBody } = parsed;
    const reader = new JsonRecordReader(parsedBody);
    return new StatusPresetRunner(ctx.engineService).run({
      presetId: String(parsedBody.presetId || ''),
      prompt: reader.optionalString('prompt'),
      question: reader.optionalString('question'),
      inputText: typeof parsedBody.inputText === 'string' ? parsedBody.inputText : undefined,
      format: parsedBody.format === 'json' ? 'json' : 'text',
      backend: parseOptionalSummaryProvider(reader.optionalString('backend')),
      model: reader.optionalString('model'),
      profile: reader.optionalString('profile'),
      sourceKind: normalizeSummarySourceKind(parsedBody.sourceKind),
      commandExitCode: reader.number('commandExitCode') ?? undefined,
      repoRoot: reader.optionalString('repoRoot'),
      maxTurns: reader.number('maxTurns') ?? undefined,
      logFile: reader.optionalString('logFile'),
    }, {
      statusBackendUrl: `${ctx.getServiceBaseUrl()}/status`,
      onSummaryProgress(event) {
        stream.emitProgress(event);
      },
      onRepoSearchProgress(event) {
        if (event.kind === 'thinking' || event.kind === 'answer') {
          return;
        }
        stream.emitProgress(event);
      },
    });
  }
}

type ParsedEvalRoute = { parsedBody: JsonObject };

class EvalRunEndpoint extends StreamedOperationEndpoint<ParsedEvalRoute> {
  protected readonly lockKind = 'summary';
  protected readonly taskKind = 'summary';

  protected parseRequest(parsedBody: JsonObject): ParsedStreamedRequest<ParsedEvalRoute> {
    return { ok: true, value: { parsedBody } };
  }

  protected async execute(ctx: ServerContext, parsed: ParsedEvalRoute, stream: StreamedOperationStream): Promise<JsonSerializable> {
    const { parsedBody } = parsed;
    const reader = new JsonRecordReader(parsedBody);
    return ctx.engineService.runEvaluation({
      FixtureRoot: reader.optionalString('FixtureRoot'),
      RealLogPath: Array.isArray(parsedBody.RealLogPath) ? parsedBody.RealLogPath.map((value) => String(value)) : [],
      Backend: parseOptionalSummaryProvider(reader.optionalString('Backend')),
      Model: reader.optionalString('Model'),
    }, (event) => {
      stream.emitProgress(event);
    });
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run build:test; node .\dist\scripts\run-tests.js streamed-op-endpoints`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add src/status-server src/command-output tests/streamed-op-endpoints.test.ts
git commit -m "feat: convert command-output, preset, and eval endpoints to SSE"
```

---

### Task 10: CLI client — SSE consumption + progress renderer

**Files:**
- Create: `src/cli/progress-renderer.ts`
- Modify: `src/cli/status-server-api-client.ts` (five request methods)
- Test: `tests/cli-progress-renderer.test.ts`

- [ ] **Step 1: Write the failing renderer test**

```ts
// tests/cli-progress-renderer.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { CliProgressRenderer, SilentProgressRenderer } from '../src/cli/progress-renderer.js';
import { makeCaptureStream } from './_test-helpers.js';

test('renders known progress kinds as single stderr lines', () => {
  const stderr = makeCaptureStream();
  const renderer = new CliProgressRenderer(stderr.stream, 'repo-search');
  renderer.render({ kind: 'lock_wait', queueLength: 1, elapsedMs: 4200 });
  renderer.render({ kind: 'llm_start', turn: 3, maxTurns: 24, promptTokenCount: 1234 });
  renderer.render({ kind: 'tool_start', turn: 3, maxTurns: 24, command: 'git grep -n "x" src' });
  renderer.render({ kind: 'tool_result', turn: 3, maxTurns: 24, command: 'git grep -n "x" src', exitCode: 0, outputTokens: 57 });
  const lines = stderr.read().trim().split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[0], /repo-search waiting for model lock \(1 queued, 4s\)/u);
  assert.match(lines[1], /repo-search t3\/24 llm_start prompt=1,234tok/u);
  assert.match(lines[2], /repo-search t3\/24 git grep -n "x" src/u);
  assert.match(lines[3], /repo-search t3\/24 done exit=0 57tok/u);
});

test('skips thinking/answer and renders unknown kinds by name', () => {
  const stderr = makeCaptureStream();
  const renderer = new CliProgressRenderer(stderr.stream, 'summary');
  renderer.render({ kind: 'thinking', thinkingText: 'hidden' });
  renderer.render({ kind: 'answer', answerText: 'hidden' });
  renderer.render({ kind: 'core_start', backend: 'llama.cpp' });
  const lines = stderr.read().trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /summary core_start/u);
});

test('SilentProgressRenderer renders nothing', () => {
  const stderr = makeCaptureStream();
  const renderer = new SilentProgressRenderer(stderr.stream, 'eval');
  renderer.render({ kind: 'core_start' });
  assert.equal(stderr.read(), '');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test; node .\dist\scripts\run-tests.js cli-progress-renderer`
Expected: FAIL — cannot find module

- [ ] **Step 3: Write the implementation**

```ts
// src/cli/progress-renderer.ts
import { JsonRecordReader } from '../lib/json-record-reader.js';
import type { JsonObject } from '../lib/json-types.js';
import { formatTimestamp } from '../lib/text-format.js';

const SKIPPED_KINDS = new Set(['thinking', 'answer']);

function formatTokens(value: number | null): string {
  return value === null ? '' : `${value.toLocaleString('en-US')}tok`;
}

/** Renders streamed operation progress as one stderr line per event. */
export class CliProgressRenderer {
  constructor(
    private readonly stderr: NodeJS.WritableStream,
    private readonly opLabel: string,
  ) {}

  render(event: JsonObject): void {
    const reader = new JsonRecordReader(event);
    const kind = reader.optionalString('kind') || '';
    if (!kind || SKIPPED_KINDS.has(kind)) {
      return;
    }
    const line = this.describe(kind, reader);
    if (line) {
      this.stderr.write(`${formatTimestamp()} ${this.opLabel} ${line}\n`);
    }
  }

  private describe(kind: string, reader: JsonRecordReader): string {
    const turn = reader.number('turn');
    const maxTurns = reader.number('maxTurns');
    const turnPrefix = turn !== null && maxTurns !== null ? `t${turn}/${maxTurns} ` : '';
    if (kind === 'lock_wait') {
      const queueLength = reader.number('queueLength') ?? 0;
      const seconds = Math.round((reader.number('elapsedMs') ?? 0) / 1000);
      return `waiting for model lock (${queueLength} queued, ${seconds}s)`;
    }
    if (kind === 'tool_start') {
      return `${turnPrefix}${reader.optionalString('command') || ''}`.trim();
    }
    if (kind === 'tool_result') {
      const exitCode = reader.number('exitCode');
      const outputTokens = reader.number('outputTokens');
      return `${turnPrefix}done exit=${exitCode ?? '?'} ${formatTokens(outputTokens)}`.trim();
    }
    if (kind === 'llm_start' || kind === 'llm_end') {
      return `${turnPrefix}${kind} prompt=${formatTokens(reader.number('promptTokenCount'))}`.trim();
    }
    return `${turnPrefix}${kind}`.trim();
  }
}

/** Explicit no-op renderer for non-rendering callers (eval, internal ops). */
export class SilentProgressRenderer extends CliProgressRenderer {
  override render(_event: JsonObject): void {}
}
```

(If `JsonRecordReader.number` has a different name for numeric access, mirror the
actual API — see `src/lib/json-record-reader.ts`.)

- [ ] **Step 4: Run renderer test**

Run: `npm run build:test; node .\dist\scripts\run-tests.js cli-progress-renderer`
Expected: PASS

- [ ] **Step 5: Rework `StatusServerApiClient`**

Replace the five `post*` privates and their public wrappers in
`src/cli/status-server-api-client.ts` with a single streamed core plus typed
wrappers. The public method signatures gain a required renderer:

```ts
import { SseClient } from '../lib/sse-client.js';
import { OPERATION_STREAM_EVENTS, OperationStreamErrorSchema } from '../lib/operation-stream.js';
import { parseJsonText, parseJsonObjectText } from '../lib/json.js';
import type { CliProgressRenderer } from './progress-renderer.js';

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export class StatusServerApiClient {
  // getConfig() and listPresets() keep their current plain-JSON implementations.

  async requestSummary(request: SummaryRequest, renderer: CliProgressRenderer): Promise<SummaryResult> {
    return this.requestStreamedOperation('/summary', request, SummaryResultSchema, renderer, 'summary');
  }

  async requestRepoSearch(request: Record<string, JsonSerializable>, renderer: CliProgressRenderer): Promise<RepoSearchExecutionResult> {
    return this.requestStreamedOperation('/repo-search', request, RepoSearchExecutionResultSchema, renderer, 'repo-search');
  }

  async analyzeCommandOutput(request: CommandOutputAnalyzeRequest, renderer: CliProgressRenderer): Promise<CommandOutputAnalyzeResult> {
    return this.requestStreamedOperation('/command-output/analyze', request, CommandOutputAnalyzeResultSchema, renderer, 'command-output');
  }

  async runPreset(request: PresetRunRequest, renderer: CliProgressRenderer): Promise<PresetRunResult> {
    return this.requestStreamedOperation('/preset/run', request, PresetRunResultSchema, renderer, 'preset');
  }

  async runEvaluation(request: EvalRequest, renderer: CliProgressRenderer): Promise<EvaluationResult> {
    return this.requestStreamedOperation('/eval/run', request, EvaluationResultSchema, renderer, 'eval');
  }

  private async requestStreamedOperation<T>(
    pathname: string,
    request: JsonSerializable,
    schema: z.ZodType<T>,
    renderer: CliProgressRenderer,
    task: LoggedHttpClientTask,
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      for await (const frame of new SseClient().stream({
        url: this.getServiceUrl(pathname),
        body: JSON.stringify(request),
        idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
      })) {
        if (frame.event === OPERATION_STREAM_EVENTS.progress) {
          renderer.render(parseJsonObjectText(frame.data));
          continue;
        }
        if (frame.event === OPERATION_STREAM_EVENTS.error) {
          throw new Error(OperationStreamErrorSchema.parse(parseJsonObjectText(frame.data)).message);
        }
        if (frame.event === OPERATION_STREAM_EVENTS.result) {
          logHttpClientBoundary(task, 'caller_response_received', `elapsed_ms=${Math.max(0, Date.now() - startedAt)}`);
          return parseJsonText(frame.data, schema);
        }
      }
      throw new Error('Operation stream ended before a result frame.');
    } catch (error) {
      throw this.normalizeError(toError(error));
    }
  }
}
```

Keep `getConfig`, `listPresets`, `getServiceUrl`, and `normalizeError` as they are
(`normalizeError` already maps `ECONNREFUSED`-style failures to the
server-unavailable message and passes `HTTP <status>:` errors through — the
`SseClient` error format was chosen to match it).
`SummaryRequest.onProgress` must not be serialized: it is optional and CLI callers
never set it, so `JSON.stringify` drops nothing — no change needed.

- [ ] **Step 6: Typecheck (call sites break — expected)**

Run: `npm run typecheck:test`
Expected: FAIL only at CLI runner call sites (`run-summary.ts` etc.) — fixed next task. If anything else breaks, fix it now.

- [ ] **Step 7: Commit**

```bash
git add src/cli/progress-renderer.ts src/cli/status-server-api-client.ts tests/cli-progress-renderer.test.ts
git commit -m "feat: CLI api client consumes SSE streams with a progress renderer"
```

---

### Task 11: Wire renderers through dispatch and runners

**Files:**
- Modify: `src/cli/dispatch.ts` (thread `stderr` into runners)
- Modify: `src/cli/run-summary.ts`, `run-command.ts`, `run-repo-search.ts`, `run-eval.ts`, `run-preset.ts`, `run-internal.ts`

- [ ] **Step 1: Thread stderr + renderers**

Pattern (identical in every runner; shown for `run-repo-search.ts`):

```ts
import { CliProgressRenderer } from './progress-renderer.js';

export async function runRepoSearchCli(options: {
  argv: string[];
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}): Promise<number> {
  // ...existing parsing unchanged...
  const renderer = new CliProgressRenderer(options.stderr, 'repo-search');
  const response = await new StatusServerApiClient().requestRepoSearch({
    prompt,
    repoRoot: process.cwd(),
    model: parsed.model,
    logFile: parsed.logFile,
  }, renderer);
  // ...existing output formatting unchanged...
}
```

Per file:
- `run-summary.ts` — `new CliProgressRenderer(options.stderr, 'summary')`, pass to `requestSummary`.
- `run-command.ts` — `new CliProgressRenderer(options.stderr, 'run')`, pass to `analyzeCommandOutput`.
- `run-preset.ts` — `new CliProgressRenderer(options.stderr, 'preset')`, pass to `runPreset`.
- `run-eval.ts` — `new SilentProgressRenderer(options.stderr, 'eval')` (spec: eval is non-rendering).
- `run-internal.ts` — `new SilentProgressRenderer(options.stdout, 'internal')` for every api-client call (internal ops emit machine-readable JSON on stdout; keep them quiet). `runInternal`'s options gains no stderr — `SilentProgressRenderer` never writes, so the stream argument is inert; pass `options.stdout`.
- `dispatch.ts` — pass `stderr` into each updated runner call
  (`runSummary({ ..., stderr })`, `runCommandCli({ argv: options.argv, stdout, stderr })`,
  `runRepoSearchCli({ argv: options.argv, stdout, stderr })`,
  `runEvalCli({ argv: options.argv, stdout, stderr })`,
  `runPresetCli({ argv: options.argv, stdinText: options.stdinText, stdout, stderr })`).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck:test`
Expected: PASS (src compiles; test files that mock JSON servers fail at runtime, not typecheck — rewritten next task)

- [ ] **Step 3: Commit**

```bash
git add src/cli
git commit -m "feat: wire CLI progress renderers through dispatch and runners"
```

---

### Task 12: Rewrite CLI-facing tests to SSE mock servers

**Files:**
- Modify: `tests/repo-search-cli.test.ts`, `tests/summary-cli.test.ts`, `tests/cli-preset.test.ts`, `tests/command.test.ts`, `tests/cli-run-shell.test.ts`, `tests/cli-http-boundary.test.ts`, `tests/runtime-cli.test.ts` (whichever of these stand up mock HTTP servers answering the five paths — find them with a grep for `'/summary'`, `'/repo-search'`, `'/command-output/analyze'`, `'/preset/run'`, `'/eval/run'` under `tests/`)

- [ ] **Step 1: Mechanical rewrite of mock servers**

Every mock handler that answered a streamed path with
`res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify(result))`
now calls the Task 7 helper:

```ts
import { writeSseResult } from './helpers/sse-http.js';
// ...
writeSseResult(res, result);
```

Exemplar — `tests/repo-search-cli.test.ts:60-69` becomes:

```ts
function writeMockRepoSearchResponse(res: http.ServerResponse, finalOutput = 'Found planner tools in src/summary.ts'): void {
  const result: RepoSearchExecutionResult = {
    requestId: 'req-1',
    transcriptPath: 'C:\\tmp\\repo-search.jsonl',
    artifactPath: 'C:\\tmp\\repo-search.json',
    scorecard: buildMockScorecard(finalOutput),
  };
  writeSseResult(res, result, [{ kind: 'llm_start', turn: 1, maxTurns: 24, promptTokenCount: 10 }]);
}
```

and the assertion set gains one line verifying progress rendering:

```ts
assert.match(output.stderr, /repo-search t1\/24 llm_start/u);
```

Stdout purity assertions stay exactly as they are (`output.stdout` must equal the
final result only) — that is the pipe-safety guarantee.

- [ ] **Step 2: `tests/repo-search-cli.test.ts` timeout test**

The test 'repo-search CLI leaves prompt timeout to server after queue admission'
patched `setTimeout` to assert no client-side deadline. Under SSE there IS an
idle timer (10 min) reset by heartbeats. Rewrite the assertion: collect
`setTimeout` calls and assert every recorded timeout equals `600000` (the idle
timeout), none smaller.

- [ ] **Step 3: Run all CLI tests**

Run: `npm run build:test; node .\dist\scripts\run-tests.js cli; node .\dist\scripts\run-tests.js command; node .\dist\scripts\run-tests.js summary-cli`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add tests
git commit -m "test: rewrite CLI mock servers to SSE transport"
```

---

### Task 13: Rewrite server-side tests that POST JSON to the five endpoints

**Files:**
- Modify: `tests/repo-search-status-server.test.ts` (7 requestJson calls to `/repo-search`, 1 to `/summary`)
- Modify: any other file found by grepping `requestJson(` + the five paths under `tests/` (at minimum check `runtime-status-server.idle-persistence.test.ts`, `status-server-shutdown.test.ts`, `preset-runner.test.ts`, `dashboard-run-log-admin.test.ts`)

- [ ] **Step 1: Mechanical conversion**

Each `await requestJson(`${baseUrl}/repo-search`, { method: 'POST', body })` becomes
`await requestSse(`${baseUrl}/repo-search`, { body: <object form> })` with assertion
translation:

| Old assertion | New assertion |
|---|---|
| `response.statusCode === 200` + body scorecard | `response.result !== null` + same scorecard reads on `response.result` |
| `response.statusCode === 503` + `/Timed out waiting/` in `body.error` | `response.errorMessage` matches `/Timed out waiting/` (HTTP status is 200 — stream already open) |
| `response.statusCode === 500` + `/sanity check failed/` | `response.errorMessage` matches `/sanity check failed/iu` |
| `response.statusCode === 400` (missing prompt) | unchanged — still plain HTTP 400, `response.frames.length === 0` |

Queue-timeout run_logs assertions (`terminal_state = 'failed'`) are unchanged —
`onOperationFailed` still calls `markRepoSearchAdmissionFailed`.

- [ ] **Step 2: Run the server test files**

Run: `npm run build:test; node .\dist\scripts\run-tests.js repo-search-status-server; node .\dist\scripts\run-tests.js status-server; node .\dist\scripts\run-tests.js preset-runner`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests
git commit -m "test: rewrite server endpoint tests to SSE transport"
```

---

### Task 14: Full gate

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: PASS. Fix any straggler (grep for remaining `requestJson` against the five paths, remaining `logSummaryProgress` references, remaining `postSummary`-style dead code in the api client).

- [ ] **Step 2: Lint + typecheck everything**

Run: `npm run typecheck`
Expected: PASS (includes eslint gate — the repo's no-cast/no-any rules are enforced there).

- [ ] **Step 3: Verify no dead code remains**

- `Grep 'postSummary|postRepoSearch|postCommandOutput|postPresetRun|postEvalRun' src` → zero hits.
- `Grep 'logSummaryProgress' src tests` → zero hits.
- `Grep "requestJson\(.*(/summary|/repo-search|/command-output/analyze|/preset/run|/eval/run)" tests` → zero hits.

- [ ] **Step 4: Commit any cleanup**

```bash
git add -A
git commit -m "chore: streamed transport cleanup — remove dead JSON-transport code"
```

---

## Correction implementation (execute Tasks 15-19 only)

The executable correction tasks are specified in
`docs/superpowers/plans/2026-07-22-streamed-cli-transport-corrections.md`.
