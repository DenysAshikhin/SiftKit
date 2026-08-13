import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type { KeyCustody } from '@siftkit/contracts';
import { z } from '../src/lib/zod.js';
import { ZipWriter, readZip } from '../src/lib/zip.js';
import { AssistantService } from '../src/assistant/assistant-service.js';
import { FixedClock } from '../src/assistant/clock.js';
import { BackupService } from '../src/assistant/control/backup-service.js';
import { DeletionPreviewService } from '../src/assistant/control/deletion-preview.js';
import { ExportService } from '../src/assistant/control/export-service.js';
import { FactoryResetService } from '../src/assistant/control/factory-reset-service.js';
import {
  MAX_PENDING_RESTORE_UPLOADS, RestoreService,
} from '../src/assistant/control/restore-service.js';
import { EstimateTokenCounter } from '../src/assistant/domain/tokens.js';
import { AssistantConflictError, AssistantNotFoundError } from '../src/assistant/errors.js';
import { SequentialIdGenerator } from '../src/assistant/ids.js';
import { ProjectionCompiler } from '../src/assistant/projections/projection-compiler.js';
import type {
  ProjectionSummaryService,
  SummarizeProjectionResult,
} from '../src/assistant/projections/projection-summarizer.js';
import { dpapiUnprotect } from '../src/assistant/crypto/dpapi.js';
import {
  KeyCustodyService, type AssistantCustodyConfigPort,
} from '../src/assistant/crypto/key-custody.js';
import { ImportedKeyProvider } from '../src/assistant/crypto/imported-key-provider.js';
import { FileKeyProvider } from '../src/assistant/crypto/key-provider.js';
import { assistantKeyFile, assistantRestoreUploadsDir } from '../src/assistant/layout.js';
import { OWNER_PERSON_CANONICAL_KEY } from '../src/assistant/storage/schema.js';
import { DEFAULT_ASSISTANT_CONFIG } from '../src/config/defaults.js';
import {
  closeRuntimeDatabase, getRuntimeDatabase, CURRENT_SCHEMA_VERSION,
} from '../src/state/runtime-db.js';
import {
  FIXTURE_START_INSTANT, MemoryAssistantConfigWriter, withAssistantContextAsync,
  type AssistantTestContext,
} from './helpers/assistant-fixture.js';
import { FakeAssistantInference } from './helpers/assistant-inference-fake.js';
import { seedOwnerAssertion } from './helpers/gate-e-seed.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

class PassthroughSummarizer implements ProjectionSummaryService {
  async summarize(): Promise<SummarizeProjectionResult> {
    return { kind: 'unchanged', reason: 'passthrough' };
  }
}

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
  });
}

function exportServiceFor(context: AssistantTestContext): ExportService {
  return new ExportService(context.graph, context.database, context.ownerId);
}

function factoryResetServiceFor(context: AssistantTestContext): FactoryResetService {
  return new FactoryResetService({
    graph: context.graph,
    database: context.database,
    clock: context.clock,
    previews: new DeletionPreviewService(context.graph, context.database),
    keyCustody: custodyFor(context),
  });
}

function restoreServiceFor(
  context: AssistantTestContext,
  keyCustody: KeyCustodyService = custodyFor(context),
): RestoreService {
  return new RestoreService({
    graph: context.graph,
    database: context.database,
    keyCustody,
  });
}

/** Re-zips an entry map, so a test can mutate entries and hand the result back to restore. */
function rebuild(archive: Map<string, Buffer>): Buffer {
  const writer = new ZipWriter();
  for (const [name, bytes] of archive) writer.add(name, bytes);
  return writer.build();
}

class AlwaysIdle {
  isIdle(): boolean {
    return true;
  }
}

/** A full service plus a context view over its graph, for tests that seed then drive the API. */
function buildServiceContext(): { service: AssistantService; context: AssistantTestContext } {
  const runtimeRoot = createManagedTempDir('siftkit-assistant-restore-');
  const database = getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite'));
  const clock = new FixedClock(FIXTURE_START_INSTANT);
  const ids = new SequentialIdGenerator();
  const service = AssistantService.create({
    database, runtimeRoot, clock, ids,
    configWriter: new MemoryAssistantConfigWriter(),
    inference: new FakeAssistantInference([]),
    tokens: new EstimateTokenCounter(4),
    idleGate: new AlwaysIdle(),
    config: { ...DEFAULT_ASSISTANT_CONFIG, Enabled: true },
  });
  return {
    service,
    context: { database, clock, ids, ownerId: service.ownerId, runtimeRoot, graph: service.graph },
  };
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

test('backup → factory reset → restore round-trips the graph, projections, and blobs', async () => {
  await withAssistantContextAsync(async (context) => {
    seedOwnerAssertion(context, { objectName: 'Upsilon Tool' });
    seedOwnerAssertion(context, { objectName: 'Phi Tool' });
    await new ProjectionCompiler(
      context.graph, new EstimateTokenCounter(4), new PassthroughSummarizer(),
      { 1: 10_000, 2: 50_000, 3: 10_000 },
    ).compileAll(context.ownerId, new AbortController().signal);

    const exports = exportServiceFor(context);
    const before = readZip(await exports.export({ includeDecryptedBlobs: false }));
    const backupBytes = await backupServiceFor(context).createBackup();

    const factoryResets = factoryResetServiceFor(context);
    factoryResets.confirm(context.ownerId, factoryResets.preview(context.ownerId).previewToken);
    assert.equal(context.graph.projections.listAllRows(context.ownerId).length, 0);

    const restores = restoreServiceFor(context);
    const preview = restores.preview(backupBytes);
    assert.equal(preview.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.ok(preview.fileCount > 0 && preview.totalBytes > 0);
    const result = await restores.confirm(preview.uploadId, preview.confirmToken);
    assert.deepEqual(result, { ok: true, blobsReadable: true, warning: null });

    // A byte-identical export means the graph and projections came back exactly.
    const after = readZip(await exports.export({ includeDecryptedBlobs: false }));
    assert.deepEqual(
      [...after.entries()].map(([name, data]) => [name, data.toString('base64')]).sort(),
      [...before.entries()].map(([name, data]) => [name, data.toString('base64')]).sort(),
    );

    // Evidence decrypts again, so the key survived the round trip.
    const evidence = context.graph.evidence.list(context.ownerId, 10, 0)
      .find((row) => row.blob_id !== null);
    assert.ok(evidence !== undefined && evidence.blob_id !== null);
    assert.ok(context.graph.evidence.readBlobBytes(evidence.blob_id).byteLength > 0);
  });
});

test('restore refuses a tampered manifest hash before touching anything', async () => {
  await withAssistantContextAsync(async (context) => {
    const seeded = seedOwnerAssertion(context, { objectName: 'Chi Tool' });
    const archive = readZip(await backupServiceFor(context).createBackup());
    const snapshot = archive.get('snapshot.sqlite') ?? Buffer.alloc(0);

    archive.set('snapshot.sqlite', Buffer.concat([snapshot, Buffer.of(1)]));
    assert.throws(() => restoreServiceFor(context).preview(rebuild(archive)), /hash/iu);
    assert.equal(
      context.graph.assertions.requireAssertion(seeded.assertion.id).status,
      seeded.assertion.status,
    );
  });
});

test('restore refuses a newer schema version', async () => {
  await withAssistantContextAsync(async (context) => {
    seedOwnerAssertion(context, { objectName: 'Psi Tool' });
    const archive = readZip(await backupServiceFor(context).createBackup());
    const manifest = ManifestSchema.parse(
      JSON.parse(archive.get('manifest.json')?.toString('utf8') ?? ''),
    );

    // Only the version differs: `manifest.json` is not hashed in `files`, so the rest still verifies.
    archive.set('manifest.json', Buffer.from(JSON.stringify({
      ...manifest, schemaVersion: CURRENT_SCHEMA_VERSION + 1,
    }), 'utf8'));
    assert.throws(() => restoreServiceFor(context).preview(rebuild(archive)), /schema/iu);
  });
});

test('a wrong confirm token is a conflict and an unknown upload is a not-found', async () => {
  await withAssistantContextAsync(async (context) => {
    const seeded = seedOwnerAssertion(context, { objectName: 'Omega Tool' });
    const restores = restoreServiceFor(context);
    const preview = restores.preview(await backupServiceFor(context).createBackup());

    await assert.rejects(
      restores.confirm(preview.uploadId, 'wrong-token'),
      AssistantConflictError,
    );
    await assert.rejects(
      restores.confirm('upload_missing', preview.confirmToken),
      AssistantNotFoundError,
    );
    assert.equal(
      context.graph.assertions.requireAssertion(seeded.assertion.id).status,
      seeded.assertion.status,
    );
    // The rejected attempts left the upload usable.
    assert.equal((await restores.confirm(preview.uploadId, preview.confirmToken)).ok, true);
  });
});

test('a backup whose key cannot be unsealed restores loudly, not silently', async () => {
  await withAssistantContextAsync(async (context) => {
    seedOwnerAssertion(context, { objectName: 'Alpha Two' });
    const archive = readZip(await backupServiceFor(context).createBackup());

    // Corrupt only the sealed key: DPAPI must refuse it while everything else verifies.
    const sealed = archive.get('key.protected') ?? Buffer.alloc(0);
    const damaged = Buffer.from(sealed);
    damaged[Math.floor(damaged.byteLength / 2)] ^= 0xff;
    const manifest = ManifestSchema.parse(
      JSON.parse(archive.get('manifest.json')?.toString('utf8') ?? ''),
    );
    archive.set('key.protected', damaged);
    archive.set('manifest.json', Buffer.from(JSON.stringify({
      ...manifest,
      files: {
        ...manifest.files,
        'key.protected': createHash('sha256').update(damaged).digest('hex'),
      },
    }), 'utf8'));

    const restores = restoreServiceFor(context);
    const preview = restores.preview(rebuild(archive));
    const result = await restores.confirm(preview.uploadId, preview.confirmToken);

    assert.equal(result.ok, true);
    assert.equal(result.blobsReadable, false);
    assert.match(result.warning ?? '', /unreadable/iu);
    // The graph itself still came back.
    assert.ok(context.graph.evidence.list(context.ownerId, 10, 0).length > 0);
  });
});

test('a parked upload lives under the runtime root and a new service sweeps it', async () => {
  await withAssistantContextAsync(async (context) => {
    seedOwnerAssertion(context, { objectName: 'Kappa Tool' });
    const backupBytes = await backupServiceFor(context).createBackup();
    restoreServiceFor(context).preview(backupBytes);

    // Parked inside the runtime root — never the world-readable system temp directory.
    const uploadsDir = assistantRestoreUploadsDir(context.runtimeRoot);
    assert.ok(fs.existsSync(uploadsDir) && fs.readdirSync(uploadsDir).length > 0);

    // A new service — a daemon restart — has no memory of the upload and must not keep its bytes.
    restoreServiceFor(context);
    assert.equal(fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir).length : 0, 0);
  });
});

test('pending uploads beyond the cap evict the oldest, deleting its parked bytes', async () => {
  await withAssistantContextAsync(async (context) => {
    seedOwnerAssertion(context, { objectName: 'Lambda Tool' });
    const backupBytes = await backupServiceFor(context).createBackup();
    const restores = restoreServiceFor(context);

    const first = restores.preview(backupBytes);
    let last = first;
    for (let index = 0; index < MAX_PENDING_RESTORE_UPLOADS; index += 1) {
      last = restores.preview(backupBytes);
    }

    await assert.rejects(
      restores.confirm(first.uploadId, first.confirmToken),
      AssistantNotFoundError,
    );
    const uploadsDir = assistantRestoreUploadsDir(context.runtimeRoot);
    assert.equal(fs.readdirSync(uploadsDir).length, MAX_PENDING_RESTORE_UPLOADS);
    assert.equal((await restores.confirm(last.uploadId, last.confirmToken)).ok, true);
  });
});

test('restore runs through the service maintenance path and refreshes the owner cache', async () => {
  try {
    const { service, context } = buildServiceContext();
    seedOwnerAssertion(context, { objectName: 'Iota Tool' });
    const backupBytes = await service.backups.createBackup();

    await service.factoryReset(service.previewFactoryReset().previewToken);
    assert.equal(service.ownerPersonNodeId, null);

    const preview = service.previewRestore(backupBytes);
    const result = await service.restore(preview.uploadId, preview.confirmToken);
    assert.equal(result.ok, true);
    assert.equal(result.blobsReadable, true);

    // The cached owner person id points at the restored node, not a stale pre-restore one.
    const restored = service.graph.nodes.findByCanonicalKey(
      service.ownerId, 'person', OWNER_PERSON_CANONICAL_KEY,
    );
    assert.ok(restored !== null);
    assert.equal(service.ownerPersonNodeId, restored.id);
  } finally {
    closeRuntimeDatabase();
  }
});
