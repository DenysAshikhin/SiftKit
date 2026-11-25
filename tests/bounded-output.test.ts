import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { z } from 'zod';

import { BoundedOutput, copyText } from '../src/lib/bounded-output.ts';

const MIB = 1024 * 1024;
setFlagsFromString('--expose-gc');
const collect = z.custom<() => void>((value) => typeof value === 'function').parse(runInNewContext('gc'));
const droppedNote = (bytes: number) => `\n[${bytes} bytes of output dropped here: only the start and end were kept.]\n`;

function write(output: BoundedOutput, text: string, chunkBytes: number): void {
  const bytes = Buffer.from(text);
  for (let at = 0; at < bytes.length; at += chunkBytes) output.write(bytes.subarray(at, at + chunkBytes));
}

test('output at or under the window is kept whole, whatever the chunks', () => {
  for (const chunkBytes of [1, 3, 7, 100]) {
    for (const length of [0, 1, 4, 5, 9, 10]) {
      const output = new BoundedOutput({ kind: 'window', headBytes: 4, tailBytes: 6 });
      const text = 'abcdefghij'.slice(0, length);
      write(output, text, chunkBytes);
      assert.equal(output.text(), text, `${length} bytes in chunks of ${chunkBytes}`);
      assert.equal(output.dropped, 0);
    }
  }
});

test('output over the window keeps its start and end and names what it dropped', () => {
  for (const chunkBytes of [1, 2, 5, 6, 7, 11, 1000]) {
    for (const length of [11, 12, 17, 26]) {
      const output = new BoundedOutput({ kind: 'window', headBytes: 4, tailBytes: 6 });
      const text = 'abcdefghijklmnopqrstuvwxyz'.slice(0, length);
      write(output, text, chunkBytes);
      assert.equal(output.text(), `${text.slice(0, 4)}${droppedNote(length - 10)}${text.slice(-6)}`, `${length} bytes in chunks of ${chunkBytes}`);
      assert.equal(output.dropped, length - 10);
    }
  }
});

test('a character cut at either edge of the window is dropped whole', () => {
  for (const character of ['é', 'ℹ', '😀']) {
    for (let headBytes = 0; headBytes < 9; headBytes += 1) {
      for (let tailBytes = 1; tailBytes < 9; tailBytes += 1) {
        const output = new BoundedOutput({ kind: 'window', headBytes, tailBytes });
        write(output, character.repeat(20), 5);
        assert.ok(!output.text().includes('�'), `${character} head ${headBytes} tail ${tailBytes}: ${output.text()}`);
      }
    }
  }
});

test('a limit keeps exactly its bytes and reports the first one past it', () => {
  const output = new BoundedOutput({ kind: 'limit', bytes: 5 });
  output.write(Buffer.from('12345'));
  assert.deepEqual([output.text(), output.dropped], ['12345', 0]);
  output.write(Buffer.from('6'));
  assert.equal(output.dropped, 1);
});

test('memory follows the output up to the window and is freed on release', () => {
  const output = new BoundedOutput({ kind: 'window', headBytes: 2 * MIB, tailBytes: 6 * MIB });
  output.write(Buffer.from('x'));
  assert.ok(output.capacity <= 64 * 1024, String(output.capacity));
  const chunk = Buffer.alloc(64 * 1024, 97);
  for (let written = 0; written < 600 * MIB; written += chunk.length) output.write(chunk);
  assert.equal(output.capacity, 8 * MIB);
  output.release();
  assert.deepEqual([output.capacity, output.text()], [0, '']);
});

test('a copied tail does not keep the text it was cut from alive', async () => {
  assert.equal(copyText('héllo ✖'), 'héllo ✖');
  collect();
  const before = process.memoryUsage().heapUsed + process.memoryUsage().external;
  const tails: string[] = [];
  for (let index = 0; index < 20; index += 1) tails.push(copyText(Buffer.alloc(16 * MIB, 97 + index).toString('latin1').slice(-1_000)));
  // Buffers are freed off the main thread, after the collection that finds them dead.
  collect();
  await delay(100);
  collect();
  const grown = process.memoryUsage().heapUsed + process.memoryUsage().external - before;
  assert.equal(tails.length, 20);
  assert.ok(grown < 160 * MIB, `${Math.round(grown / MIB)} MiB kept for 20 tails of 1,000 characters`);
});
