import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { SequentialIdGenerator } from '../src/assistant/ids.ts';
import { attachmentEmbed, VaultAttachments, vaultAttachmentsDir } from '../src/vault/attachments.ts';
import { VaultNotFoundError } from '../src/vault/errors.ts';
import { TEST_META, entityInput, withVault } from './helpers/vault-fixture.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

test('write stores the file under the vault root with a row carrying size and sha256', () => {
  withVault(({ database, clock, store, runtimeRoot }) => {
    const note = store.create(entityInput('Shot', ''), TEST_META);
    const attachments = new VaultAttachments(database, clock, new SequentialIdGenerator(), runtimeRoot);
    const written = attachments.write({ directory: 'captures', mimeType: 'image/png', bytes: PNG });
    assert.equal(written.noteId, null);
    attachments.assign(written.id, note.id);
    assert.equal(attachments.require(written.id).noteId, note.id);
    assert.equal(written.relativePath, `captures/${written.id}.png`);
    assert.equal(written.byteLength, PNG.byteLength);
    assert.equal(written.sha256, createHash('sha256').update(PNG).digest('hex'));
    assert.deepEqual(fs.readFileSync(path.join(vaultAttachmentsDir(runtimeRoot), 'captures', `${written.id}.png`)), PNG);
    assert.equal(attachmentEmbed(written.relativePath), `![[attachments/captures/${written.id}.png]]`);
    assert.deepEqual(attachments.read(written.relativePath), { mimeType: 'image/png', bytes: PNG });
  });
});

test('read refuses unknown, escaping and removed paths with not-found', () => {
  withVault(({ database, clock, runtimeRoot }) => {
    const attachments = new VaultAttachments(database, clock, new SequentialIdGenerator(), runtimeRoot);
    const written = attachments.write({ directory: 'captures', mimeType: 'image/jpeg', bytes: PNG });
    assert.ok(written.relativePath.endsWith('.jpg'));
    fs.writeFileSync(path.join(runtimeRoot, 'secret.txt'), 'nope');
    for (const bad of ['captures/missing.png', '../../secret.txt', '..\\..\\secret.txt', '/etc/passwd', 'C:/Windows/win.ini', '']) {
      assert.throws(() => attachments.read(bad), VaultNotFoundError, bad);
    }
    attachments.removeFile(written.id);
    assert.throws(() => attachments.read(written.relativePath), VaultNotFoundError);
    attachments.removeFile(written.id);
  });
});
