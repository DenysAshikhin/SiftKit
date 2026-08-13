import assert from 'node:assert/strict';
import test from 'node:test';

import { ZipWriter, readZip } from '../src/lib/zip.js';

test('round-trips stored and deflated entries byte-for-byte', () => {
  const writer = new ZipWriter();
  writer.add('manifest.json', Buffer.from('{"a":1}'));
  writer.add('blobs/aa/deadbeef', Buffer.alloc(70_000, 7)); // compressible, > one chunk
  writer.add('empty.txt', Buffer.alloc(0));
  const archive = writer.build();

  const entries = readZip(archive);
  assert.deepEqual([...entries.keys()].sort(), ['blobs/aa/deadbeef', 'empty.txt', 'manifest.json']);
  assert.equal(entries.get('manifest.json')?.toString('utf8'), '{"a":1}');
  assert.equal(entries.get('blobs/aa/deadbeef')?.equals(Buffer.alloc(70_000, 7)), true);
  assert.equal(entries.get('empty.txt')?.byteLength, 0);
});

test('the same input always produces the same archive bytes', () => {
  const build = (): Buffer => {
    const writer = new ZipWriter();
    writer.add('a.txt', Buffer.from('alpha'));
    writer.add('b.bin', Buffer.alloc(4096, 3));
    return writer.build();
  };
  assert.equal(build().equals(build()), true);
});

test('preserves non-ASCII entry names', () => {
  const writer = new ZipWriter();
  writer.add('topics/café-münchen.md', Buffer.from('naïve'));
  const entries = readZip(writer.build());
  assert.equal(entries.get('topics/café-münchen.md')?.toString('utf8'), 'naïve');
});

test('rejects a corrupted entry via CRC mismatch', () => {
  const writer = new ZipWriter();
  // High-entropy 8 bytes: deflate cannot shrink them, so the writer picks method 0 (store)
  // and the flipped byte reaches the CRC check instead of dying inside inflate.
  writer.add('a.bin', Buffer.from('9f8e7d6c5b4a3210', 'hex').subarray(0, 8));
  const archive = writer.build();
  archive[30 + 'a.bin'.length + 2] ^= 0xff; // inside the stored data
  assert.throws(() => readZip(archive), /CRC/u);
});

test('rejects non-zip input', () => {
  assert.throws(() => readZip(Buffer.from('not a zip')), /end of central directory/iu);
});

test('rejects a truncated archive rather than returning partial entries', () => {
  const writer = new ZipWriter();
  writer.add('a.txt', Buffer.from('alpha'));
  const archive = writer.build();
  assert.throws(() => readZip(archive.subarray(0, archive.byteLength - 4)));
});
