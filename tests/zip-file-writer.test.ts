import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { readZip } from '../src/lib/zip.js';
import { ZipFileWriter } from '../src/lib/zip-file-writer.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

const LOCAL_METHOD_OFFSET = 8;
const LOCAL_CRC_OFFSET = 14;

function writeSource(directory: string, name: string, contents: Buffer): string {
  const sourcePath = path.join(directory, name);
  fs.writeFileSync(sourcePath, contents);
  return sourcePath;
}

test('ZipFileWriter output is readable by readZip', async () => {
  const dir = createManagedTempDir('zipw-roundtrip-');
  const blob = writeSource(dir, 'blob.bin', Buffer.alloc(300_000, 7));
  const archivePath = path.join(dir, 'a.zip');

  const writer = new ZipFileWriter(archivePath);
  writer.addBuffer('manifest.json', Buffer.from('{"x":1}', 'utf8'));
  await writer.addFile('blobs/blob.bin', blob);
  writer.finish();

  const entries = readZip(fs.readFileSync(archivePath));
  assert.deepEqual([...entries.keys()].sort(), ['blobs/blob.bin', 'manifest.json']);
  assert.equal(entries.get('blobs/blob.bin')?.byteLength, 300_000);
  assert.deepEqual(entries.get('blobs/blob.bin'), Buffer.alloc(300_000, 7));
  assert.equal(entries.get('manifest.json')?.toString('utf8'), '{"x":1}');
});

test('ZipFileWriter writes identical bytes for identical inputs', async () => {
  const dir = createManagedTempDir('zipw-stable-');
  const blob = writeSource(dir, 'blob.bin', Buffer.alloc(2_500_000, 3));

  const archives: Buffer[] = [];
  for (const name of ['first.zip', 'second.zip']) {
    const archivePath = path.join(dir, name);
    const writer = new ZipFileWriter(archivePath);
    writer.addBuffer('manifest.json', Buffer.from('{"x":1}', 'utf8'));
    await writer.addFile('blobs/blob.bin', blob);
    writer.finish();
    archives.push(fs.readFileSync(archivePath));
  }

  assert.deepEqual(archives[0], archives[1]);
});

test('ZipFileWriter stores file entries and deflates buffer entries that shrink', async () => {
  const dir = createManagedTempDir('zipw-methods-');
  const blob = writeSource(dir, 'blob.bin', Buffer.alloc(200_000, 9));
  const archivePath = path.join(dir, 'a.zip');

  const writer = new ZipFileWriter(archivePath);
  writer.addBuffer('compressible.txt', Buffer.alloc(50_000, 0x61));
  await writer.addFile('blob.bin', blob);
  writer.finish();

  const archive = fs.readFileSync(archivePath);
  assert.equal(archive.readUInt16LE(LOCAL_METHOD_OFFSET), 8, 'compressible buffer entry deflates');
  assert.equal(readZip(archive).get('blob.bin')?.byteLength, 200_000);
  assert.ok(archive.byteLength < 250_000, 'the deflated buffer entry shrinks the archive');
});

test('ZipFileWriter patches the streamed entry CRC into its local header', async () => {
  const dir = createManagedTempDir('zipw-crc-');
  const blob = writeSource(dir, 'blob.bin', Buffer.from('streamed payload', 'utf8'));
  const archivePath = path.join(dir, 'a.zip');

  const writer = new ZipFileWriter(archivePath);
  await writer.addFile('blob.bin', blob);
  writer.finish();

  const archive = fs.readFileSync(archivePath);
  assert.notEqual(archive.readUInt32LE(LOCAL_CRC_OFFSET), 0);
  assert.equal(readZip(archive).get('blob.bin')?.toString('utf8'), 'streamed payload');
});

test('ZipFileWriter round-trips an empty file entry', async () => {
  const dir = createManagedTempDir('zipw-empty-');
  const blob = writeSource(dir, 'empty.bin', Buffer.alloc(0));
  const archivePath = path.join(dir, 'a.zip');

  const writer = new ZipFileWriter(archivePath);
  await writer.addFile('empty.bin', blob);
  writer.finish();

  const entries = readZip(fs.readFileSync(archivePath));
  assert.equal(entries.get('empty.bin')?.byteLength, 0);
});

test('ZipFileWriter produces an empty but valid archive when nothing is added', () => {
  const dir = createManagedTempDir('zipw-noentries-');
  const archivePath = path.join(dir, 'a.zip');

  const writer = new ZipFileWriter(archivePath);
  writer.finish();

  assert.deepEqual([...readZip(fs.readFileSync(archivePath)).keys()], []);
});

test('ZipFileWriter rejects use after finish', async () => {
  const dir = createManagedTempDir('zipw-finished-');
  const blob = writeSource(dir, 'blob.bin', Buffer.from('x', 'utf8'));
  const archivePath = path.join(dir, 'a.zip');

  const writer = new ZipFileWriter(archivePath);
  writer.finish();

  assert.throws(() => writer.finish(), /already finished/u);
  assert.throws(() => writer.addBuffer('late.txt', Buffer.from('x', 'utf8')), /already finished/u);
  await assert.rejects(writer.addFile('late.bin', blob), /already finished/u);
});

test('ZipFileWriter closes the archive when a source file is missing', async () => {
  const dir = createManagedTempDir('zipw-missing-');
  const archivePath = path.join(dir, 'a.zip');

  const writer = new ZipFileWriter(archivePath);
  await assert.rejects(writer.addFile('missing.bin', path.join(dir, 'nope.bin')));
  writer.abort();

  assert.equal(fs.existsSync(archivePath), false);
});

test('ZipFileWriter abort removes a partially written archive', async () => {
  const dir = createManagedTempDir('zipw-abort-');
  const blob = writeSource(dir, 'blob.bin', Buffer.alloc(100_000, 1));
  const archivePath = path.join(dir, 'a.zip');

  const writer = new ZipFileWriter(archivePath);
  await writer.addFile('blob.bin', blob);
  writer.abort();
  writer.abort();

  assert.equal(fs.existsSync(archivePath), false);
});
