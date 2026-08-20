import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { POWERSHELL_EXECUTABLE } from '../src/lib/powershell.js';
import { ZipFileWriter } from '../src/lib/zip-file-writer.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

const PAYLOAD = Buffer.alloc(300_000, 42);
const UNICODE_ENTRY = 'topics/café-münchen.md';

/**
 * The module doc for `src/lib/zip.ts` promises archives that Windows can open without SiftKit's
 * own reader. `ZipFileReader` cannot prove that — only a foreign unzip can. This is the
 * independent oracle that used to be `readZip`.
 *
 * Mutation-verified: corrupting the EOCD central-directory offset fails this test. It does not
 * cover CRC — Expand-Archive does not verify stored entries, and every entry this writer emits is
 * stored — so `zip.test.ts` owns the CRC case.
 */
test('ZipFileWriter output opens with Expand-Archive', { skip: process.platform !== 'win32' }, async () => {
  const dir = createManagedTempDir('zip-external-');
  const source = path.join(dir, 'payload.bin');
  fs.writeFileSync(source, PAYLOAD);

  const archivePath = path.join(dir, 'compat.zip');
  const writer = new ZipFileWriter(archivePath);
  writer.addBuffer('manifest.json', Buffer.from('{"x":1}', 'utf8'));
  // Carried for the other tools users open these archives with. Note what this does NOT prove:
  // clearing the UTF-8 flag bit (0x0800) fails nothing here, because .NET decodes entry names as
  // UTF-8 regardless — as does our own reader. No available oracle can pin that bit.
  writer.addBuffer(UNICODE_ENTRY, Buffer.from('naïve', 'utf8'));
  await writer.addFile('blobs/payload.bin', source);
  writer.finish();

  const outDir = path.join(dir, 'out');
  // -ErrorAction Stop: Expand-Archive reports a bad archive as a non-terminating error, which
  // would otherwise leave the exit status at 0 and the failure invisible.
  const result = spawnSync(POWERSHELL_EXECUTABLE, [
    '-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${outDir}' -Force -ErrorAction Stop`,
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, `Expand-Archive failed: ${result.stderr}`);
  assert.equal(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'), '{"x":1}');
  assert.equal(fs.readFileSync(path.join(outDir, 'blobs', 'payload.bin')).equals(PAYLOAD), true);
  assert.equal(fs.readFileSync(path.join(outDir, ...UNICODE_ENTRY.split('/')), 'utf8'), 'naïve');
});
