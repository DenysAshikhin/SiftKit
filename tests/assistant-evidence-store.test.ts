import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { BlobCipher } from '../src/assistant/crypto/blob-cipher.js';
import { FileKeyProvider } from '../src/assistant/crypto/key-provider.js';
import { hashBytes, hashTextContent } from '../src/assistant/domain/keys.js';
import { EvidenceStore } from '../src/assistant/storage/evidence-store.js';
import { withAssistantContext, type AssistantTestContext } from './helpers/assistant-fixture.js';

function newKeyProvider(context: AssistantTestContext): FileKeyProvider {
  return new FileKeyProvider(path.join(context.runtimeRoot, 'assistant', 'keys.json'));
}

function newEvidenceStore(context: AssistantTestContext): EvidenceStore {
  const keys = newKeyProvider(context);
  return new EvidenceStore(
    context.database, context.clock, context.ids,
    new BlobCipher(keys), path.join(context.runtimeRoot, 'assistant', 'evidence'),
  );
}

test('the key provider creates a 256-bit key once and reuses it', () => {
  withAssistantContext((context) => {
    const keys = newKeyProvider(context);
    const first = keys.getActiveKey();
    const second = keys.getActiveKey();
    assert.equal(first.material.byteLength, 32);
    assert.equal(first.keyId, second.keyId);
    assert.deepEqual([...first.material], [...second.material]);

    const reloaded = newKeyProvider(context).getActiveKey();
    assert.equal(reloaded.keyId, first.keyId);
    assert.deepEqual([...reloaded.material], [...first.material]);

    // The key lives outside the runtime database on purpose: a stolen database alone must not
    // decrypt evidence blobs.
    assert.ok(fs.existsSync(path.join(context.runtimeRoot, 'assistant', 'keys.json')));
    const encoded = first.material.toString('base64');
    const leaked = context.database
      .prepare('SELECT COUNT(*) AS count FROM runtime_metadata WHERE value LIKE ?')
      .get(`%${encoded}%`);
    assert.deepEqual(leaked, { count: 0 });
  });
});

test('blob cipher round-trips bytes and records the plaintext hash', () => {
  withAssistantContext((context) => {
    const cipher = new BlobCipher(newKeyProvider(context));
    const plaintext = Buffer.from('screenshot bytes would go here', 'utf8');
    const { envelope, keyId } = cipher.encrypt(plaintext);
    assert.equal(keyId, newKeyProvider(context).getActiveKey().keyId);
    assert.notEqual(envelope.indexOf(plaintext), 0);
    const decrypted = cipher.decrypt(envelope);
    assert.deepEqual([...decrypted], [...plaintext]);
  });
});

test('a tampered ciphertext, auth tag, or header is a hard read error', () => {
  withAssistantContext((context) => {
    const cipher = new BlobCipher(newKeyProvider(context));
    const { envelope } = cipher.encrypt(Buffer.from('sensitive', 'utf8'));

    const flippedCiphertext = Buffer.from(envelope);
    flippedCiphertext[flippedCiphertext.length - 1] ^= 0xff;
    assert.throws(() => cipher.decrypt(flippedCiphertext), /authentication|tamper/i);

    const truncated = envelope.subarray(0, envelope.length - 4);
    assert.throws(() => cipher.decrypt(truncated), /authentication|tamper|envelope/i);

    const badMagic = Buffer.from(envelope);
    badMagic[0] = 0x00;
    assert.throws(() => cipher.decrypt(badMagic), /envelope/i);
  });
});

test('text evidence is stored, deduplicated by source event id, and read back', () => {
  withAssistantContext((context) => {
    const evidence = newEvidenceStore(context);
    const first = evidence.recordTextEvidence({
      ownerId: context.ownerId, deviceId: null, sourceEventId: 'chat:msg_1',
      parentEvidenceId: null, sourceType: 'conversation_message', sourceRef: 'session_1',
      capturedAtUtc: '2026-08-05T09:00:00.000Z', sourceTimezone: 'UTC',
      sensitivity: 'personal', retentionUntilUtc: null, metadata: { role: 'user' },
      text: 'I prefer PowerShell on Windows.',
    });
    assert.equal(first.content_hash, hashTextContent('I prefer PowerShell on Windows.'));
    assert.equal(first.status, 'active');
    assert.equal(first.blob_id, null);

    const replay = evidence.recordTextEvidence({
      ownerId: context.ownerId, deviceId: null, sourceEventId: 'chat:msg_1',
      parentEvidenceId: null, sourceType: 'conversation_message', sourceRef: 'session_1',
      capturedAtUtc: '2026-08-05T09:00:00.000Z', sourceTimezone: 'UTC',
      sensitivity: 'personal', retentionUntilUtc: null, metadata: { role: 'user' },
      text: 'I prefer PowerShell on Windows.',
    });
    assert.equal(replay.id, first.id);
    assert.equal(evidence.countEvidence(context.ownerId), 1);
  });
});

test('blob evidence writes one content-addressed encrypted file and shares it across events', () => {
  withAssistantContext((context) => {
    const evidence = newEvidenceStore(context);
    const bytes = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const shared = {
      ownerId: context.ownerId, deviceId: null, parentEvidenceId: null,
      sourceType: 'screenshot', sourceRef: null, sourceTimezone: 'UTC',
      sensitivity: 'sensitive', retentionUntilUtc: null, metadata: {},
      mimeType: 'image/png', bytes,
    } as const;

    const first = evidence.recordBlobEvidence({
      ...shared, sourceEventId: 'cap_1', capturedAtUtc: '2026-08-05T09:00:00.000Z',
    });
    const second = evidence.recordBlobEvidence({
      ...shared, sourceEventId: 'cap_2', capturedAtUtc: '2026-08-05T09:05:00.000Z',
    });

    assert.notEqual(first.id, second.id);
    assert.equal(first.blob_id, second.blob_id);
    assert.equal(evidence.countBlobs(context.ownerId), 1);

    const blob = evidence.requireBlob(first.blob_id ?? '');
    assert.equal(blob.encrypted, true);
    assert.equal(blob.key_id, newKeyProvider(context).getActiveKey().keyId);
    assert.equal(blob.content_hash, hashBytes(bytes));

    const onDisk = path.join(
      context.runtimeRoot, 'assistant', 'evidence',
      blob.content_hash.slice(0, 2), blob.content_hash,
    );
    assert.ok(fs.existsSync(onDisk));
    assert.equal(fs.readFileSync(onDisk).includes(bytes), false, 'plaintext must not hit disk');

    assert.deepEqual([...evidence.readBlobBytes(blob.id)], [...bytes]);
  });
});

test('reading a blob whose file was swapped for different content is rejected', () => {
  withAssistantContext((context) => {
    const evidence = newEvidenceStore(context);
    const bytes = Buffer.from('original', 'utf8');
    const record = evidence.recordBlobEvidence({
      ownerId: context.ownerId, deviceId: null, sourceEventId: 'cap_1', parentEvidenceId: null,
      sourceType: 'screenshot', sourceRef: null, capturedAtUtc: '2026-08-05T09:00:00.000Z',
      sourceTimezone: 'UTC', sensitivity: 'sensitive', retentionUntilUtc: null, metadata: {},
      mimeType: 'image/png', bytes,
    });
    const blob = evidence.requireBlob(record.blob_id ?? '');
    const onDisk = path.join(
      context.runtimeRoot, 'assistant', 'evidence',
      blob.content_hash.slice(0, 2), blob.content_hash,
    );

    const cipher = new BlobCipher(newKeyProvider(context));
    fs.writeFileSync(onDisk, cipher.encrypt(Buffer.from('substituted', 'utf8')).envelope);
    assert.throws(() => evidence.readBlobBytes(blob.id), /hash mismatch/i);
  });
});

test('a storage uri that escapes the evidence root is rejected before any file access', () => {
  withAssistantContext((context) => {
    const evidence = newEvidenceStore(context);
    assert.throws(
      () => evidence.resolveBlobPath('../../../etc/passwd'),
      /content hash|evidence root/i,
    );
    assert.throws(() => evidence.resolveBlobPath('..'), /content hash|evidence root/i);
    assert.throws(() => evidence.resolveBlobPath(''), /content hash|evidence root/i);
  });
});

test('deleting evidence purges the blob file and marks the record deleted', () => {
  withAssistantContext((context) => {
    const evidence = newEvidenceStore(context);
    const record = evidence.recordBlobEvidence({
      ownerId: context.ownerId, deviceId: null, sourceEventId: 'cap_1', parentEvidenceId: null,
      sourceType: 'screenshot', sourceRef: null, capturedAtUtc: '2026-08-05T09:00:00.000Z',
      sourceTimezone: 'UTC', sensitivity: 'sensitive', retentionUntilUtc: null, metadata: {},
      mimeType: 'image/png', bytes: Buffer.from('bytes', 'utf8'),
    });
    const blob = evidence.requireBlob(record.blob_id ?? '');
    const onDisk = path.join(
      context.runtimeRoot, 'assistant', 'evidence',
      blob.content_hash.slice(0, 2), blob.content_hash,
    );
    assert.ok(fs.existsSync(onDisk));

    evidence.deleteEvidence(record.id);

    assert.equal(fs.existsSync(onDisk), false);
    assert.equal(evidence.requireEvidence(record.id).status, 'deleted');
    assert.equal(evidence.requireBlob(blob.id).deleted_at_utc !== null, true);
  });
});

test('a blob still referenced by another live evidence record survives deletion of one', () => {
  withAssistantContext((context) => {
    const evidence = newEvidenceStore(context);
    const bytes = Buffer.from('shared bytes', 'utf8');
    const shared = {
      ownerId: context.ownerId, deviceId: null, parentEvidenceId: null,
      sourceType: 'screenshot', sourceRef: null, sourceTimezone: 'UTC',
      sensitivity: 'sensitive', retentionUntilUtc: null, metadata: {},
      mimeType: 'image/png', bytes,
    } as const;
    const first = evidence.recordBlobEvidence({
      ...shared, sourceEventId: 'cap_1', capturedAtUtc: '2026-08-05T09:00:00.000Z',
    });
    const second = evidence.recordBlobEvidence({
      ...shared, sourceEventId: 'cap_2', capturedAtUtc: '2026-08-05T09:05:00.000Z',
    });

    evidence.deleteEvidence(first.id);
    assert.equal(evidence.requireEvidence(second.id).status, 'active');
    assert.deepEqual([...evidence.readBlobBytes(second.blob_id ?? '')], [...bytes]);
  });
});