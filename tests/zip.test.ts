import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ZipFileReader } from '../src/lib/zip-file-reader.js';
import { ZipFileWriter } from '../src/lib/zip-file-writer.js';
import { readArchiveEntries } from './helpers/archive-bytes.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

function build(entries: readonly (readonly [string, Buffer])[], prefix: string): string {
  const archivePath = path.join(createManagedTempDir(prefix), 'a.zip');
  const writer = new ZipFileWriter(archivePath);
  for (const [name, data] of entries) writer.addBuffer(name, data);
  writer.finish();
  return archivePath;
}

test('round-trips stored and deflated entries byte-for-byte', async () => {
  const archivePath = build([
    ['manifest.json', Buffer.from('{"a":1}')],
    ['blobs/aa/deadbeef', Buffer.alloc(70_000, 7)], // compressible, > one chunk
    ['empty.txt', Buffer.alloc(0)],
  ], 'zip-roundtrip-');

  const entries = await readArchiveEntries(archivePath);
  assert.deepEqual([...entries.keys()].sort(), ['blobs/aa/deadbeef', 'empty.txt', 'manifest.json']);
  assert.equal(entries.get('manifest.json')?.toString('utf8'), '{"a":1}');
  assert.equal(entries.get('blobs/aa/deadbeef')?.equals(Buffer.alloc(70_000, 7)), true);
  assert.equal(entries.get('empty.txt')?.byteLength, 0);
});

test('the same input always produces the same archive bytes', () => {
  const first = build([['a.txt', Buffer.from('alpha')], ['b.bin', Buffer.alloc(4096, 3)]], 'zip-stable-1-');
  const second = build([['a.txt', Buffer.from('alpha')], ['b.bin', Buffer.alloc(4096, 3)]], 'zip-stable-2-');
  assert.equal(fs.readFileSync(first).equals(fs.readFileSync(second)), true);
});

test('preserves non-ASCII entry names', async () => {
  const archivePath = build([['topics/café-münchen.md', Buffer.from('naïve')]], 'zip-utf8-');
  assert.equal((await readArchiveEntries(archivePath)).get('topics/café-münchen.md')?.toString('utf8'), 'naïve');
});

test('rejects a corrupted entry via CRC mismatch', async () => {
  // High-entropy 8 bytes: deflate cannot shrink them, so the writer picks method 0 (store)
  // and the flipped byte reaches the CRC check instead of dying inside inflate.
  const archivePath = build([['a.bin', Buffer.from('9f8e7d6c5b4a3210', 'hex')]], 'zip-crc-');
  const archive = fs.readFileSync(archivePath);
  archive[30 + 'a.bin'.length + 2] ^= 0xff; // inside the stored data
  fs.writeFileSync(archivePath, archive);

  const reader = await ZipFileReader.open(archivePath);
  try {
    assert.throws(() => reader.readEntry('a.bin'), /CRC/u);
  } finally {
    await reader.close();
  }
});

test('rejects non-zip input', async () => {
  const notZip = path.join(createManagedTempDir('zip-notzip-'), 'not.zip');
  fs.writeFileSync(notZip, Buffer.from('not a zip'));
  await assert.rejects(ZipFileReader.open(notZip), /end of central directory/iu);
});

test('rejects a truncated archive rather than returning partial entries', async () => {
  const archivePath = build([['a.txt', Buffer.from('alpha')]], 'zip-truncated-');
  const archive = fs.readFileSync(archivePath);
  const truncated = path.join(createManagedTempDir('zip-truncated-out-'), 'a.zip');
  fs.writeFileSync(truncated, archive.subarray(0, archive.byteLength - 4));
  await assert.rejects(ZipFileReader.open(truncated));
});
