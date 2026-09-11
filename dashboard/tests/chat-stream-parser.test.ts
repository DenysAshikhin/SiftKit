import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_PROJECTION_MAX_FRAME_BYTES, ChatTranscriptMessageSchema, type ChatProjectionFrame } from '@siftkit/contracts';
import { parseChatStreamPacket, ChatStreamReader, type ChatStreamEvent } from '../src/lib/chat-stream-parser';
import { ChatOperationProjection } from '../src/lib/chat-operation-projection';
import { chatProjectionCapture, chatQueueState, chatSnapshotFrames, nextTransferId, projectionPackets } from './chat-snapshot-fixture.js';

const encoder = new TextEncoder();

function readerOf(chunks: readonly Uint8Array[], onRelease?: () => void): ReadableStreamDefaultReader<Uint8Array> {
  let index = 0;
  return {
    async read() {
      const value = chunks[index];
      if (value === undefined) return { value: undefined, done: true };
      index += 1;
      return { value, done: false };
    },
    async cancel() {},
    releaseLock() { onRelease?.(); },
    closed: Promise.resolve(undefined),
  };
}

async function collect(reader: ReadableStreamDefaultReader<Uint8Array>, maxPacketBytes?: number | null): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  const stream = maxPacketBytes === undefined ? new ChatStreamReader(reader) : new ChatStreamReader(reader, maxPacketBytes);
  for await (const event of stream.events()) events.push(event);
  return events;
}

function frameOf(data: string, overrides: Partial<ChatProjectionFrame> = {}): ChatProjectionFrame {
  return { version: 2, transferId: nextTransferId(), recordIndex: 0, chunkIndex: 0, finalChunk: true, data, ...overrides };
}

test('malformed, unknown and incomplete packets fail instead of disappearing; empty ones are ignored', () => {
  assert.throws(() => parseChatStreamPacket('event: chat_projection\ndata: {not-json'), /Malformed/u);
  assert.throws(() => parseChatStreamPacket('event: chat_projection\ndata: {"version":1,"transferId":"x"}'), /Malformed/u);
  assert.throws(() => parseChatStreamPacket('event: snapshot\ndata: {}'), /Unsupported/u);
  assert.throws(() => parseChatStreamPacket('event: done\ndata: {}'), /Unsupported/u);
  assert.throws(() => parseChatStreamPacket('event: chat_projection'), /Malformed/u);
  assert.throws(() => parseChatStreamPacket('event: queue\ndata: {"sessionId":"s1"}'), /Malformed/u);
  assert.equal(parseChatStreamPacket(''), null);
  assert.equal(parseChatStreamPacket(': heartbeat'), null);
});

test('projection frames and queue state parse from their packets, with CRLF and multiline data', () => {
  const frame = frameOf('{"kind":"commit"}');
  assert.deepEqual(parseChatStreamPacket(`event: chat_projection\ndata: ${JSON.stringify(frame)}`), { kind: 'projection', frame });
  const queue = chatQueueState({ revision: 4 });
  const packet = `event: queue\r\n${JSON.stringify(queue, null, 2).split('\n').map(line => `data: ${line}`).join('\r\n')}`;
  assert.deepEqual(parseChatStreamPacket(packet), { kind: 'queue', queue });
});

test('a frame with another protocol version or an oversized data field is rejected', () => {
  assert.throws(() => parseChatStreamPacket(`event: chat_projection\ndata: ${JSON.stringify({ ...frameOf('{}'), version: 1 })}`), /Malformed/u);
  assert.throws(() => parseChatStreamPacket(`event: chat_projection\ndata: ${JSON.stringify(frameOf('x'.repeat(CHAT_PROJECTION_MAX_FRAME_BYTES + 1)))}`), /Malformed/u);
});

test('a real transfer survives every byte split of its wire form and reassembles the same view', async () => {
  const text = 'ünïcödé 😀 "quoted" \\ backslash 🇺🇦';
  const source = chatProjectionCapture({ messages: [ChatTranscriptMessageSchema.parse({ id: 'm', kind: 'assistant_answer', role: 'assistant', content: text,
    createdAtUtc: '2026-09-10T12:00:00.000Z', inputTokensEstimate: 0, outputTokensEstimate: 0, thinkingTokens: 0,
    inputTokensEstimated: false, outputTokensEstimated: false, thinkingTokensEstimated: false })] });
  const wire = encoder.encode(projectionPackets(chatSnapshotFrames(source)));
  for (const split of [1, 2, 3, 7, 64, 1000, wire.length - 1]) {
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < wire.length; offset += split) chunks.push(wire.slice(offset, offset + split));
    const projection = new ChatOperationProjection('s1');
    let view = null;
    for (const event of await collect(readerOf(chunks))) {
      assert.equal(event.kind, 'projection');
      if (event.kind === 'projection') view = projection.acceptFrame(event.frame) ?? view;
    }
    assert.equal(view?.kind === 'view' && view.snapshot.messages[0]?.content, text, `split ${String(split)}`);
  }
});

test('one network chunk carrying many packets is processed packet by packet', async () => {
  const frames = Array.from({ length: 40 }, (_, index) => frameOf(`"${'x'.repeat(2000)}"`, { recordIndex: index }));
  const events = await collect(readerOf([encoder.encode(projectionPackets(frames))]));
  assert.deepEqual(events.map(event => event.kind === 'projection' ? event.frame.recordIndex : -1), frames.map((_, index) => index));
});

test('a packet that outgrows the frame bound fails before more of it is buffered', async () => {
  const oversized = encoder.encode(`event: chat_projection\ndata: {"version":2,"data":"${'y'.repeat(CHAT_PROJECTION_MAX_FRAME_BYTES)}`);
  const chunks = [oversized.slice(0, 40_000), oversized.slice(40_000, 70_000)];
  let reads = 0;
  const reader = readerOf([...chunks, encoder.encode('never read')]);
  const counting: ReadableStreamDefaultReader<Uint8Array> = { ...reader, async read() { reads += 1; return reader.read(); } };
  await assert.rejects(collect(counting), /exceeds 65536 bytes/u);
  assert.equal(reads, 2);
  // Unbounded readers (the queue-only stream) reject only the malformed content, not its size.
  await assert.rejects(collect(readerOf(chunks), null), /Malformed/u);
});

test('invalid and truncated UTF-8 fail explicitly', async () => {
  await assert.rejects(collect(readerOf([new Uint8Array([0xff, 0xfe, 0x0a])])), /(?:decode|invalid|encoded)/iu);
  const truncated = encoder.encode('event: queue\ndata: {"sessionId":"s1","revision":0,"messages":[],"paused":false,"force":null}\n\n😀').slice(0, -2);
  await assert.rejects(collect(readerOf([truncated])), /(?:decode|invalid|encoded)/iu);
});

test('a trailing packet without a blank line is flushed at end of body', async () => {
  const frame = frameOf('{"kind":"commit"}');
  const events = await collect(readerOf([encoder.encode(`event: chat_projection\ndata: ${JSON.stringify(frame)}`)]));
  assert.deepEqual(events, [{ kind: 'projection', frame }]);
});

test('the reader lock is released after complete consumption and when consumption stops early', async () => {
  let released = 0;
  await collect(readerOf([], () => { released += 1; }));
  assert.equal(released, 1);
  const frame = frameOf('{"kind":"commit"}');
  const endless: ReadableStreamDefaultReader<Uint8Array> = {
    async read() { return { value: encoder.encode(`event: chat_projection\ndata: ${JSON.stringify(frame)}\n\n`), done: false }; },
    async cancel() {},
    releaseLock() { released += 1; },
    closed: Promise.resolve(undefined),
  };
  for await (const event of new ChatStreamReader(endless).events()) { void event; break; }
  assert.equal(released, 2);
});
