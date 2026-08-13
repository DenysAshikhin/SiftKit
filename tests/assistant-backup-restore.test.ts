import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import type { KeyCustody } from '@siftkit/contracts';
import { z } from '../src/lib/zod.js';
import { readZip } from '../src/lib/zip.js';
import { BackupService } from '../src/assistant/control/backup-service.js';
import { dpapiUnprotect } from '../src/assistant/crypto/dpapi.js';
import {
  KeyCustodyService, type AssistantCustodyConfigPort,
} from '../src/assistant/crypto/key-custody.js';
import { ImportedKeyProvider } from '../src/assistant/crypto/imported-key-provider.js';
import { FileKeyProvider } from '../src/assistant/crypto/key-provider.js';
import { assistantKeyFile } from '../src/assistant/layout.js';
import { CURRENT_SCHEMA_VERSION } from '../src/state/runtime-db.js';
import {
  withAssistantContextAsync, type AssistantTestContext,
} from './helpers/assistant-fixture.js';
import { seedOwnerAssertion } from './helpers/gate-e-seed.js';

class MemoryCustodyConfigPort implements AssistantCustodyConfigPort {
  constructor(private custody: KeyCustody = 'file') {}

  readCustody(): KeyCustody {
    return this.custody;
  }

  writeCustody(custody: KeyCustody): void {
    this.custody = custody;
  }
}

const ManifestSchema = z.object({
  schemaVersion: z.number().int(),
  createdAtUtc: z.string(),
  custody: z.enum(['file', 'desktop']),
  files: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/u)),
});

function custodyFor(context: AssistantTestContext): KeyCustodyService {
  return new KeyCustodyService({
    config: new MemoryCustodyConfigPort(),
    fileKeys: new FileKeyProvider(assistantKeyFile(context.runtimeRoot)),
    imported: new ImportedKeyProvider(),
    evidence: context.graph.evidence,
    ownerId: context.ownerId,
  });
}

function backupServiceFor(context: AssistantTestContext): BackupService {
  return new BackupService({
    graph: context.graph,
    database: context.database,
    keyCustody: custodyFor(context),
    runtimeRoot: context.runtimeRoot,
  });
}

test('backup carries a verified snapshot, the encrypted blob tree, and a sealed key', async () => {
  await withAssistantContextAsync(async (context) => {
    seedOwnerAssertion(context, { objectName: 'Pi Tool' });
    const archive = readZip(await backupServiceFor(context).createBackup());

    const manifest = ManifestSchema.parse(
      JSON.parse(archive.get('manifest.json')?.toString('utf8') ?? ''),
    );
    assert.equal(manifest.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(manifest.custody, 'file');
    for (const [name, hash] of Object.entries(manifest.files)) {
      const entry = archive.get(name);
      assert.ok(entry !== undefined, name);
      assert.equal(createHash('sha256').update(entry).digest('hex'), hash, name);
    }
    // The manifest covers every other entry, so nothing rides along unhashed.
    assert.deepEqual(
      Object.keys(manifest.files).sort(),
      [...archive.keys()].filter((name) => name !== 'manifest.json').sort(),
    );

    assert.ok(archive.has('snapshot.sqlite'));
    assert.ok(archive.has('key.protected'));
    assert.ok([...archive.keys()].some((name) => name.startsWith('blobs/')));
  });
});

test('the backed-up key is sealed, and unseals to the live key material', async () => {
  await withAssistantContextAsync(async (context) => {
    seedOwnerAssertion(context, { objectName: 'Rho Tool' });
    const custody = custodyFor(context);
    const archive = readZip(await new BackupService({
      graph: context.graph,
      database: context.database,
      keyCustody: custody,
      runtimeRoot: context.runtimeRoot,
    }).createBackup());

    const sealed = archive.get('key.protected');
    assert.ok(sealed !== undefined);
    assert.equal(sealed.toString('utf8').includes('"keys"'), false);

    const opened = z.object({
      schemaVersion: z.literal(1), activeKeyId: z.string(), keys: z.record(z.string(), z.string()),
    }).parse(JSON.parse((await dpapiUnprotect(sealed)).toString('utf8')));
    assert.deepEqual(opened, custody.exportForBackup());
  });
});

test('the snapshot is a readable database carrying the same rows', async () => {
  await withAssistantContextAsync(async (context) => {
    const seeded = seedOwnerAssertion(context, { objectName: 'Sigma Tool' });
    const archive = readZip(await backupServiceFor(context).createBackup());

    const snapshot = archive.get('snapshot.sqlite');
    assert.ok(snapshot !== undefined && snapshot.byteLength > 0);
    assert.equal(snapshot.subarray(0, 15).toString('utf8'), 'SQLite format 3');
    // The seeded assertion id appears verbatim in the snapshot's pages.
    assert.ok(snapshot.includes(Buffer.from(seeded.assertion.id, 'utf8')));
  });
});

test('every blob file on disk reaches the archive with its encrypted bytes intact', async () => {
  await withAssistantContextAsync(async (context) => {
    seedOwnerAssertion(context, { objectName: 'Tau Tool' });
    const blob = context.graph.evidence.findLatestBlob(context.ownerId);
    assert.ok(blob !== null);
    const envelope = context.graph.evidence.readBlobEnvelope(blob);

    const archive = readZip(await backupServiceFor(context).createBackup());
    const blobEntries = [...archive.entries()].filter(([name]) => name.startsWith('blobs/'));
    assert.equal(blobEntries.length, 1);
    const [name, bytes] = blobEntries[0] ?? ['', Buffer.alloc(0)];
    assert.equal(name.includes('\\'), false); // forward slashes only, for cross-tool readers
    assert.equal(bytes.equals(envelope), true);
    // Still ciphertext: the plaintext must not be recoverable from the archive alone.
    assert.equal(bytes.includes(Buffer.from('Tau Tool', 'utf8')), false);
  });
});
