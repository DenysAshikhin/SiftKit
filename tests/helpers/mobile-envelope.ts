import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';

import type { MobileEnvelope } from '@siftkit/contracts';
import { signingPayload } from '../../src/assistant/mobile/envelope-verifier.js';
import type { DeviceStore } from '../../src/assistant/storage/device-store.js';

export type UnsignedEnvelope = Omit<MobileEnvelope, 'signature'>;

/** One Ed25519 pair for the whole suite: enrolment is the device row, not the key. */
export const TEST_DEVICE_KEYS = generateKeyPairSync('ed25519');

export const TEST_DEVICE_ID = 'dev_test';

export function publicKeyBase64(key: KeyObject = TEST_DEVICE_KEYS.publicKey): string {
  return key.export({ format: 'der', type: 'spki' }).toString('base64');
}

/** Enrols the device the envelopes are signed for, in whatever state the case needs. */
export function seedTestDevice(
  devices: DeviceStore,
  ownerId: string,
  overrides: { publicKeyBase64?: string | null; status?: 'active' | 'revoked' } = {},
): void {
  devices.insertDevice({
    id: TEST_DEVICE_ID,
    ownerId,
    platform: 'android',
    displayName: 'Test Phone',
    publicKeyBase64: overrides.publicKeyBase64 === undefined
      ? publicKeyBase64()
      : overrides.publicKeyBase64,
    status: overrides.status ?? 'active',
  });
}

export function unsignedEnvelope(overrides: Partial<UnsignedEnvelope> = {}): UnsignedEnvelope {
  return {
    schemaVersion: 1,
    deviceId: TEST_DEVICE_ID,
    monotonicTimestamp: 1_000,
    nonce: 'nonce-0001',
    consent: { memory: true, sensitive: false },
    sensitivity: 'personal',
    payload: { kind: 'text', text: 'the user prefers dark mode' },
    ...overrides,
  };
}

export function signEnvelope(
  envelope: UnsignedEnvelope,
  privateKey: KeyObject = TEST_DEVICE_KEYS.privateKey,
): MobileEnvelope {
  const signature = cryptoSign(null, Buffer.from(signingPayload(envelope), 'utf8'), privateKey);
  return { ...envelope, signature: signature.toString('base64') };
}
