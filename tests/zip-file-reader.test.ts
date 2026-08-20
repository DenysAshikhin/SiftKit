import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ZipFileReader } from '../src/lib/zip-file-reader.js';
import { ZipFileWriter } from '../src/lib/zip-file-writer.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

// Larger than one READ_CHUNK_BYTES (1 MiB), so a chunked walk spans several iterations and gives
// the event loop several chances to run -- which is what the non-blocking test below measures.
// Kept as small as that requirement allows: this fixture is built by six tests in a parallel run.
const BLOB_BYTES = 3_000_000;
const MANIFEST_TEXT = '{"x":1}';

interface Fixture {
  readonly dir: string;
  readonly archivePath: string;
  readonly blobContents: Buffer;
}

async function buildFixture(prefix: string): Promise<Fixture> {
  const dir = createManagedTempDir(prefix);
  const blobContents = Buffer.alloc(BLOB_BYTES, 7);
  const blob = path.join(dir, 'blob.bin');
  fs.writeFileSync(blob, blobContents);
  const archivePath = path.join(dir, 'a.zip');
  const writer = new ZipFileWriter(archivePath);
  writer.addBuffer('manifest.json', Buffer.from(MANIFEST_TEXT, 'utf8'));
  await writer.addFile('blobs/blob.bin', blob);
  writer.finish();
  return { dir, archivePath, blobContents };
}

test('ZipFileReader lists entries and extracts them with CRC verification', async () => {
  const { dir, archivePath, blobContents } = await buildFixture('zipr-basic-');
  const reader = await ZipFileReader.open(archivePath);
  try {
    assert.deepEqual(reader.entryNames().sort(), ['blobs/blob.bin', 'manifest.json']);
    assert.equal(reader.readEntry('manifest.json').toString('utf8'), MANIFEST_TEXT);

    const out = path.join(dir, 'restored.bin');
    await reader.extractTo('blobs/blob.bin', out);
    assert.equal(fs.statSync(out).size, BLOB_BYTES);
    assert.deepEqual(fs.readFileSync(out), blobContents);
  } finally {
    await reader.close();
  }
});

test('ZipFileReader reports uncompressed sizes and hashes entries without loading them', async () => {
  const { archivePath, blobContents } = await buildFixture('zipr-hash-');
  const reader = await ZipFileReader.open(archivePath);
  try {
    assert.equal(reader.entrySize('blobs/blob.bin'), BLOB_BYTES);
    assert.equal(reader.entrySize('manifest.json'), MANIFEST_TEXT.length);
    assert.equal(
      await reader.hashEntry('blobs/blob.bin'),
      createHash('sha256').update(blobContents).digest('hex'),
    );
    assert.equal(
      await reader.hashEntry('manifest.json'),
      createHash('sha256').update(Buffer.from(MANIFEST_TEXT, 'utf8')).digest('hex'),
    );
  } finally {
    await reader.close();
  }
});

test('ZipFileReader round-trips a deflated entry', async () => {
  const dir = createManagedTempDir('zipr-deflated-');
  const archivePath = path.join(dir, 'a.zip');
  const compressible = Buffer.alloc(50_000, 0x61);
  const writer = new ZipFileWriter(archivePath);
  writer.addBuffer('compressible.txt', compressible);
  writer.finish();

  const reader = await ZipFileReader.open(archivePath);
  try {
    assert.equal(reader.entrySize('compressible.txt'), compressible.byteLength);
    assert.deepEqual(reader.readEntry('compressible.txt'), compressible);
    const out = path.join(dir, 'restored.txt');
    await reader.extractTo('compressible.txt', out);
    assert.deepEqual(fs.readFileSync(out), compressible);
  } finally {
    await reader.close();
  }
});

test('ZipFileReader names a missing entry rather than returning empty bytes', async () => {
  const { archivePath } = await buildFixture('zipr-missing-');
  const reader = await ZipFileReader.open(archivePath);
  try {
    assert.throws(() => reader.readEntry('nope.txt'), /no entry named nope\.txt/u);
    assert.throws(() => reader.entrySize('nope.txt'), /no entry named nope\.txt/u);
  } finally {
    await reader.close();
  }
});

test('ZipFileReader rejects a corrupted stored entry and leaves no partial output', async () => {
  const { dir, archivePath } = await buildFixture('zipr-corrupt-');
  const archive = fs.readFileSync(archivePath);
  // Flip a byte deep inside the stored payload; the central directory stays intact.
  archive[archive.byteLength - 1_000] ^= 0xff;
  const damagedPath = path.join(dir, 'damaged.zip');
  fs.writeFileSync(damagedPath, archive);

  const reader = await ZipFileReader.open(damagedPath);
  const out = path.join(dir, 'restored.bin');
  try {
    await assert.rejects(reader.extractTo('blobs/blob.bin', out), /failed its CRC check/u);
    assert.equal(fs.existsSync(out), false);
    await assert.rejects(reader.hashEntry('blobs/blob.bin'), /failed its CRC check/u);
  } finally {
    await reader.close();
  }
});

test('ZipFileReader yields to the event loop while extracting', async () => {
  const { dir, archivePath } = await buildFixture('zipr-nonblocking-');
  const reader = await ZipFileReader.open(archivePath);
  let ticks = 0;
  const ticker = setInterval(() => { ticks += 1; }, 1);
  try {
    await reader.extractTo('blobs/blob.bin', path.join(dir, 'restored.bin'));
  } finally {
    clearInterval(ticker);
    await reader.close();
  }
  assert.ok(ticks > 0, 'a synchronous extract starves timers; this must not block the event loop');
});

test('ZipFileReader rejects a file that is not a zip', async () => {
  const dir = createManagedTempDir('zipr-notzip-');
  const notZip = path.join(dir, 'not.zip');
  fs.writeFileSync(notZip, Buffer.alloc(4_096, 1));

  await assert.rejects(ZipFileReader.open(notZip), /end of central directory not found/u);
});
