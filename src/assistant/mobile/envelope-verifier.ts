import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

import type { MobileEnvelope } from '@siftkit/contracts';
import type { DeviceStore } from '../storage/device-store.js';

/**
 * The exact bytes a device signs. Field order is fixed here and nowhere else: any change to it
 * invalidates every enrolled device's signatures, which is why it is a flat positional array
 * rather than object serialization whose key order could drift.
 */
export function signingPayload(envelope: Omit<MobileEnvelope, 'signature'>): string {
  return JSON.stringify([
    envelope.schemaVersion, envelope.deviceId, envelope.monotonicTimestamp, envelope.nonce,
    envelope.consent.memory, envelope.consent.sensitive, envelope.sensitivity,
    envelope.payload.kind, envelope.payload.text,
  ]);
}

export type EnvelopeRejection =
  | 'unknown_device' | 'revoked_device' | 'missing_public_key'
  | 'bad_signature' | 'stale_timestamp' | 'replayed_nonce';

export type EnvelopeVerdict =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'rejected'; readonly reason: EnvelopeRejection };

function rejected(reason: EnvelopeRejection): EnvelopeVerdict {
  return { kind: 'rejected', reason };
}

/**
 * §7.6. Verifies a mobile envelope against its enrolled device, in a fixed order: identity and
 * status before cryptography, cryptography before the replay ledger, so an unauthenticated
 * caller can never write a nonce row.
 */
export class EnvelopeVerifier {
  constructor(private readonly devices: DeviceStore) {}

  verify(envelope: MobileEnvelope): EnvelopeVerdict {
    const device = this.devices.getDevice(envelope.deviceId);
    if (device === null) return rejected('unknown_device');
    if (device.status === 'revoked') return rejected('revoked_device');
    if (device.public_key === null) return rejected('missing_public_key');

    const { signature, ...unsigned } = envelope;
    const key = createPublicKey({
      key: Buffer.from(device.public_key, 'base64'), format: 'der', type: 'spki',
    });
    const valid = cryptoVerify(
      null, Buffer.from(signingPayload(unsigned), 'utf8'), key, Buffer.from(signature, 'base64'),
    );
    if (!valid) return rejected('bad_signature');

    if (envelope.monotonicTimestamp <= this.devices.maxMonotonicTimestamp(envelope.deviceId)) {
      return rejected('stale_timestamp');
    }
    if (!this.devices.recordNonce(envelope.deviceId, envelope.nonce, envelope.monotonicTimestamp)) {
      return rejected('replayed_nonce');
    }
    return { kind: 'accepted' };
  }
}
