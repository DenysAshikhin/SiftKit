import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import type { KeyCustody } from '@siftkit/contracts';
import { FileKeyProvider } from '../src/assistant/crypto/key-provider.js';
import { ImportedKeyProvider } from '../src/assistant/crypto/imported-key-provider.js';
import {
  CustodyDelegatingKeyProvider,
  KeyCustodyService,
  type AssistantCustodyConfigPort,
} from '../src/assistant/crypto/key-custody.js';
import { assistantKeyFile } from '../src/assistant/layout.js';
import { withAssistantContext, type AssistantTestContext } from './helpers/assistant-fixture.js';

class MemoryCustodyConfigPort implements AssistantCustodyConfigPort {
  constructor(private custody: KeyCustody = 'file') {}

  readCustody(): KeyCustody {
    return this.custody;
  }

  writeCustody(custody: KeyCustody): void {
    this.custody = custody;
  }
}

function key32(seed: number): string {
  const material = Buffer.alloc(32);
  for (let index = 0; index < material.byteLength; index += 1) material[index] = (seed + index) % 256;
  return material.toString('base64');
}

interface CustodyHarness {
  readonly service: KeyCustodyService;
  readonly config: MemoryCustodyConfigPort;
  readonly imported: ImportedKeyProvider;
  readonly fileKeys: FileKeyProvider;
  readonly keyFilePath: string;
}

function buildHarness(context: AssistantTestContext, custody: KeyCustody = 'file'): CustodyHarness {
  const keyFilePath = assistantKeyFile(context.runtimeRoot);
  const fileKeys = new FileKeyProvider(keyFilePath);
  const imported = new ImportedKeyProvider();
  const config = new MemoryCustodyConfigPort(custody);
  const service = new KeyCustodyService({
    config,
    fileKeys,
    imported,
    evidence: context.graph.evidence,
    ownerId: context.ownerId,
  });
  return { service, config, imported, fileKeys, keyFilePath };
}

function recordEvidence(context: AssistantTestContext, text: string): void {
  context.graph.evidence.recordTextEvidence({
    ownerId: context.ownerId,
    deviceId: null,
    sourceEventId: `evt_${text}`,
    parentEvidenceId: null,
    sourceType: 'conversation_message',
    sourceRef: null,
    capturedAtUtc: context.clock.nowUtc(),
    sourceTimezone: null,
    sensitivity: 'personal',
    retentionUntilUtc: null,
    metadata: {},
    text,
  });
}

test('the imported provider serves keys from memory only and refuses to guess', () => {
  const provider = new ImportedKeyProvider();
  assert.throws(() => provider.getActiveKey(), /no evidence key has been imported/i);
  assert.throws(() => provider.getKeyById('k1'), /no evidence key has been imported/i);

  provider.import({ schemaVersion: 1, activeKeyId: 'k1', keys: { k1: key32(1), k2: key32(9) } });
  assert.equal(provider.getActiveKey().keyId, 'k1');
  assert.equal(provider.getKeyById('k1').material.byteLength, 32);
  assert.equal(provider.getKeyById('k2').material.byteLength, 32);
  assert.throws(() => provider.getKeyById('k3'), /k3/);

  provider.clear();
  assert.throws(() => provider.getActiveKey(), /no evidence key has been imported/i);
});

test('the imported provider rejects material that is not a 32-byte key or is missing its active id', () => {
  const provider = new ImportedKeyProvider();
  assert.throws(
    () => provider.import({ schemaVersion: 1, activeKeyId: 'k1', keys: { k1: 'c2hvcnQ=' } }),
    /wrong length/i,
  );
  assert.throws(
    () => provider.import({ schemaVersion: 1, activeKeyId: 'k9', keys: { k1: key32(1) } }),
    /k9/,
  );
  assert.throws(() => provider.getActiveKey(), /no evidence key has been imported/i);
});

test('custody service finalizes migration atomically', () => {
  withAssistantContext((context) => {
    const harness = buildHarness(context);
    recordEvidence(context, 'evidence encrypted under the file key');

    const before = harness.service.status();
    assert.equal(before.custody, 'file');
    assert.equal(before.imported, false);
    assert.ok(fs.existsSync(harness.keyFilePath));

    const material = harness.service.exportForShell();
    const result = harness.service.finalizeMigration(material);

    assert.equal(result.custody, 'desktop');
    assert.equal(result.imported, true);
    assert.equal(result.activeKeyId, material.activeKeyId);
    assert.equal(fs.existsSync(harness.keyFilePath), false);
    assert.equal(harness.config.readCustody(), 'desktop');
    assert.equal(harness.imported.getActiveKey().keyId, material.activeKeyId);
  });
});

test('custody service migrates with no evidence yet by round-tripping the cipher', () => {
  withAssistantContext((context) => {
    const harness = buildHarness(context);
    const material = harness.service.exportForShell();
    assert.equal(harness.service.finalizeMigration(material).custody, 'desktop');
    assert.equal(fs.existsSync(harness.keyFilePath), false);
  });
});

test('finalize with mismatched keys leaves file custody untouched', () => {
  withAssistantContext((context) => {
    const harness = buildHarness(context);
    recordEvidence(context, 'evidence encrypted under the file key');
    const material = harness.service.exportForShell();

    assert.throws(
      () => harness.service.finalizeMigration({
        schemaVersion: 1, activeKeyId: 'wrong', keys: { wrong: key32(3) },
      }),
      /key ids/i,
    );
    assert.throws(
      () => harness.service.finalizeMigration({
        schemaVersion: 1, activeKeyId: material.activeKeyId, keys: { [material.activeKeyId]: key32(3) },
      }),
      /tampered with|authentication/i,
    );

    assert.ok(fs.existsSync(harness.keyFilePath));
    assert.equal(harness.config.readCustody(), 'file');
    assert.equal(harness.service.status().imported, false);
    assert.throws(() => harness.imported.getActiveKey(), /no evidence key has been imported/i);
  });
});

test('export is only legal in file custody and import is idempotent in desktop custody', () => {
  withAssistantContext((context) => {
    const harness = buildHarness(context);
    recordEvidence(context, 'evidence encrypted under the file key');
    const material = harness.service.exportForShell();
    harness.service.finalizeMigration(material);

    assert.throws(() => harness.service.exportForShell(), /desktop custody/i);
    assert.throws(() => harness.service.finalizeMigration(material), /file custody/i);

    harness.imported.clear();
    const reimported = harness.service.importFromShell(material);
    assert.equal(reimported.custody, 'desktop');
    assert.equal(reimported.imported, true);
    assert.equal(harness.imported.getActiveKey().keyId, material.activeKeyId);

    assert.throws(
      () => harness.service.importFromShell({
        schemaVersion: 1, activeKeyId: material.activeKeyId, keys: { [material.activeKeyId]: key32(3) },
      }),
      /tampered with|authentication/i,
    );
  });
});

test('importFromShell in file custody performs the migration', () => {
  withAssistantContext((context) => {
    const harness = buildHarness(context);
    const material = harness.service.exportForShell();
    assert.equal(harness.service.importFromShell(material).custody, 'desktop');
    assert.equal(fs.existsSync(harness.keyFilePath), false);
  });
});

test('the delegating provider follows the configured custody and fails loudly before import', () => {
  withAssistantContext((context) => {
    const harness = buildHarness(context);
    const delegating = new CustodyDelegatingKeyProvider(
      harness.config, harness.fileKeys, harness.imported,
    );
    const fileKeyId = delegating.getActiveKey().keyId;

    harness.config.writeCustody('desktop');
    assert.throws(() => delegating.getActiveKey(), /no evidence key has been imported/i);

    harness.imported.import({ schemaVersion: 1, activeKeyId: fileKeyId, keys: { [fileKeyId]: key32(4) } });
    assert.equal(delegating.getActiveKey().keyId, fileKeyId);

    harness.config.writeCustody('file');
    assert.equal(delegating.getActiveKey().keyId, fileKeyId);
    assert.equal(delegating.getKeyById(fileKeyId).keyId, fileKeyId);
  });
});
