import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  PROMPT_TOKEN_CACHE_ENTRIES,
  PromptTokenCounter,
  type PromptCountRequest,
  type PromptSegment,
} from '../src/providers/prompt-token-counter.ts';
import { parseJsonValueText } from '../src/lib/json.ts';
import { JsonValueSchema, type JsonValue } from '../src/lib/json-types.ts';
import { z } from '../src/lib/zod.ts';
import { readBody } from './helpers/runtime-http.ts';
import { getAddressInfo } from './helpers/dashboard-http.ts';
import { tabbyTokenEncodeResponse } from './helpers/tabby-token-encode.ts';

const EncodeBodySchema = z.object({
  text: z.union([z.string(), z.array(z.object({ role: z.string(), content: z.string() }))]),
}).loose();

type RecordedEncode = { body: JsonValue; authorization: string | undefined };

/** One token per character: plain text by length, messages by role plus content. */
function fakeTokenCount(body: JsonValue): number {
  const { text } = EncodeBodySchema.parse(body);
  return typeof text === 'string'
    ? text.length
    : text.reduce((total, message) => total + message.role.length + message.content.length, 0);
}

class FakeTokenEngine implements AsyncDisposable {
  readonly encodes: RecordedEncode[] = [];
  available = true;
  private readonly server: http.Server;

  private constructor(server: http.Server) {
    this.server = server;
  }

  static async start(): Promise<FakeTokenEngine> {
    const engine: { current: FakeTokenEngine | null } = { current: null };
    const server = http.createServer(async (request, response) => {
      const body = JsonValueSchema.parse(parseJsonValueText(await readBody(request)));
      engine.current?.encodes.push({ body, authorization: request.headers.authorization });
      response.setHeader('content-type', 'application/json');
      if (!engine.current?.available) {
        response.statusCode = 503;
        response.end(JSON.stringify({ error: 'tokenizer unavailable' }));
        return;
      }
      response.end(JSON.stringify(tabbyTokenEncodeResponse(fakeTokenCount(body))));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    engine.current = new FakeTokenEngine(server);
    return engine.current;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${getAddressInfo(this.server).port}`;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

const SEGMENT_DRIFT = 4;

function textSegments(texts: readonly string[]): PromptSegment[] {
  return texts.map((text) => ({ identity: text, text }));
}

function request(engine: FakeTokenEngine, texts: readonly string[], overrides: Partial<PromptCountRequest> = {}): PromptCountRequest {
  return {
    target: { baseUrl: engine.baseUrl },
    contextKey: 'ctx',
    segments: textSegments(texts),
    exactBody: { text: texts.join('') },
    limitTokens: 1_000_000,
    segmentDriftTokens: SEGMENT_DRIFT,
    tokenizeOptions: { retryMaxWaitMs: 0 },
    ...overrides,
  };
}

test('a first count encodes the exact body and is exact', async () => {
  await using engine = await FakeTokenEngine.start();
  const result = await new PromptTokenCounter().count(request(engine, ['alpha ', 'beta']));

  assert.deepEqual(result.ok && { tokenCount: result.tokenCount, driftTokens: result.driftTokens }, {
    tokenCount: 'alpha beta'.length,
    driftTokens: 0,
  });
  assert.deepEqual(engine.encodes.map((encode) => encode.body), [{ text: 'alpha beta' }]);
});

test('appended segments encode only their text, without BOS, and carry drift per segment', async () => {
  await using engine = await FakeTokenEngine.start();
  const counter = new PromptTokenCounter();
  await counter.count(request(engine, ['alpha ', 'beta']));

  const result = await counter.count(request(engine, ['alpha ', 'beta', ' gamma', ' delta']));

  assert.ok(result.ok);
  assert.equal(result.tokenCount, 'alpha beta gamma delta'.length);
  assert.equal(result.driftTokens, 2 * SEGMENT_DRIFT);
  assert.deepEqual(engine.encodes[1]?.body, { text: ' gamma delta', add_bos_token: false });
});

test('an identical prompt reuses its count without encoding', async () => {
  await using engine = await FakeTokenEngine.start();
  const counter = new PromptTokenCounter();
  await counter.count(request(engine, ['alpha ', 'beta']));

  const result = await counter.count(request(engine, ['alpha ', 'beta']));

  assert.ok(result.ok);
  assert.equal(result.tokenization, null);
  assert.equal(engine.encodes.length, 1);
});

test('a changed earlier segment is counted exactly', async () => {
  await using engine = await FakeTokenEngine.start();
  const counter = new PromptTokenCounter();
  await counter.count(request(engine, ['alpha ', 'beta']));

  const result = await counter.count(request(engine, ['ALPHA ', 'beta', ' gamma']));

  assert.ok(result.ok);
  assert.equal(result.driftTokens, 0);
  assert.deepEqual(engine.encodes[1]?.body, { text: 'ALPHA beta gamma' });
});

test('a different context key never reuses another context count', async () => {
  await using engine = await FakeTokenEngine.start();
  const counter = new PromptTokenCounter();
  await counter.count(request(engine, ['alpha ', 'beta']));

  await counter.count(request(engine, ['alpha ', 'beta', ' gamma'], { contextKey: 'other tools' }));

  assert.deepEqual(engine.encodes[1]?.body, { text: 'alpha beta gamma' });
});

test('a reused count far from the limit is kept even when large', async () => {
  await using engine = await FakeTokenEngine.start();
  const counter = new PromptTokenCounter();
  const base = 'a'.repeat(5_000);
  await counter.count(request(engine, [base], { limitTokens: 5_010 + SEGMENT_DRIFT + 1 }));

  const result = await counter.count(request(engine, [base, 'b'.repeat(10)], { limitTokens: 5_010 + SEGMENT_DRIFT + 1 }));

  assert.ok(result.ok);
  assert.equal(result.tokenCount, 5_010);
  assert.equal(engine.encodes.length, 2);
});

test('a reused count whose drift could reach the limit is recounted exactly, which resets the drift', async () => {
  await using engine = await FakeTokenEngine.start();
  const counter = new PromptTokenCounter();
  const base = 'a'.repeat(5_000);
  await counter.count(request(engine, [base], { limitTokens: 5_010 + SEGMENT_DRIFT }));

  const recounted = await counter.count(request(engine, [base, 'b'.repeat(10)], { limitTokens: 5_010 + SEGMENT_DRIFT }));
  const next = await counter.count(request(engine, [base, 'b'.repeat(10), 'c']));

  assert.ok(recounted.ok && next.ok);
  assert.equal(recounted.driftTokens, 0);
  assert.deepEqual(engine.encodes.map((encode) => encode.body), [
    { text: base },
    { text: 'b'.repeat(10), add_bos_token: false },
    { text: `${base}${'b'.repeat(10)}` },
    { text: 'c', add_bos_token: false },
  ]);
  assert.equal(next.driftTokens, SEGMENT_DRIFT);
});

test('a failed encode reports its tokenization and stores nothing', async () => {
  await using engine = await FakeTokenEngine.start();
  const counter = new PromptTokenCounter();
  await counter.count(request(engine, ['alpha ', 'beta']));

  engine.available = false;
  const failed = await counter.count(request(engine, ['alpha ', 'beta', ' gamma']));
  engine.available = true;
  const recovered = await counter.count(request(engine, ['alpha ', 'beta', ' gamma', ' delta']));

  assert.equal(failed.ok, false);
  assert.equal(failed.tokenization?.httpStatusCode, 503);
  assert.ok(recovered.ok);
  // The cache still held only 'alpha beta', so recovery appends from there.
  assert.deepEqual(engine.encodes.at(-1)?.body, { text: ' gamma delta', add_bos_token: false });
});

test('the least recently used prompt is evicted once the cache is full', async () => {
  await using engine = await FakeTokenEngine.start();
  const counter = new PromptTokenCounter();
  for (let index = 0; index <= PROMPT_TOKEN_CACHE_ENTRIES; index += 1) {
    await counter.count(request(engine, ['shared'], { contextKey: `conversation-${index}` }));
  }
  const encodesBefore = engine.encodes.length;

  await counter.count(request(engine, ['shared', ' more'], { contextKey: 'conversation-0' }));
  await counter.count(request(engine, ['shared', ' more'], { contextKey: `conversation-${PROMPT_TOKEN_CACHE_ENTRIES}` }));

  assert.deepEqual(engine.encodes.slice(encodesBefore).map((encode) => encode.body), [
    { text: 'shared more' },
    { text: ' more', add_bos_token: false },
  ]);
});

test('every encode carries the target authorization', async () => {
  await using engine = await FakeTokenEngine.start();
  const counter = new PromptTokenCounter();
  const target = { baseUrl: engine.baseUrl, authorization: 'Bearer caller' };
  await counter.count(request(engine, ['alpha '], { target }));
  await counter.count(request(engine, ['alpha ', 'beta'], { target }));

  assert.deepEqual(engine.encodes.map((encode) => encode.authorization), ['Bearer caller', 'Bearer caller']);
});

test('an identical drifting prompt is recounted exactly once a lower limit could be reached', async () => {
  await using engine = await FakeTokenEngine.start();
  const counter = new PromptTokenCounter();
  await counter.count(request(engine, ['alpha ']));
  await counter.count(request(engine, ['alpha ', 'beta']));

  const result = await counter.count(request(engine, ['alpha ', 'beta'], { limitTokens: 'alpha beta'.length + SEGMENT_DRIFT }));

  assert.ok(result.ok);
  assert.equal(result.driftTokens, 0);
  assert.deepEqual(engine.encodes.at(-1)?.body, { text: 'alpha beta' });
});
