import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import {
  DpapiUnavailableError, dpapiProtect, dpapiUnprotect,
} from '../src/assistant/crypto/dpapi.js';

test('DPAPI round-trips bytes under the current user', async () => {
  const secret = Buffer.from('gate-e-key-material-0123456789abcdef');
  const sealed = await dpapiProtect(secret);
  assert.equal(sealed.equals(secret), false);

  const opened = await dpapiUnprotect(sealed);
  assert.equal(opened.equals(secret), true);
});

test('DPAPI round-trips binary key material, not just text', async () => {
  const secret = Buffer.alloc(32);
  for (let index = 0; index < secret.byteLength; index += 1) secret[index] = (index * 7) % 256;
  assert.equal((await dpapiUnprotect(await dpapiProtect(secret))).equals(secret), true);
});

test('DPAPI round-trips a payload far larger than a command line can carry', async () => {
  // A multi-key export can exceed the ~32K character command-line limit; the payload must not
  // ride on argv at all — both for size and to keep key material out of process listings.
  const secret = randomBytes(48_000);
  assert.equal((await dpapiUnprotect(await dpapiProtect(secret))).equals(secret), true);
});

test('tampered ciphertext fails closed as DpapiUnavailableError', async () => {
  const sealed = await dpapiProtect(Buffer.from('payload'));
  sealed[Math.floor(sealed.byteLength / 2)] ^= 0xff;
  await assert.rejects(dpapiUnprotect(sealed), DpapiUnavailableError);
});

test('unprotecting bytes that were never protected fails closed', async () => {
  await assert.rejects(dpapiUnprotect(Buffer.from('not a dpapi blob')), DpapiUnavailableError);
});
