import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { z } from '../../lib/zod.js';
import type { AssistantKeyProvider } from './key-provider.js';

const MAGIC = Buffer.from('SKEV1\0', 'latin1');
const HEADER_LENGTH_BYTES = 4;
const IV_BYTE_LENGTH = 12;
const ALGORITHM = 'aes-256-gcm';

const EnvelopeHeaderSchema = z.object({
  version: z.literal(1),
  algorithm: z.literal('AES-256-GCM'),
  keyId: z.string().min(1),
  iv: z.string().min(1),
  authTag: z.string().min(1),
  plaintextSha256: z.string().length(64),
});

/** An envelope plus the id of the key that sealed it, so callers can record it alongside the row. */
export interface EncryptedBlob {
  readonly envelope: Buffer;
  readonly keyId: string;
}

/**
 * AES-256-GCM envelope encryption for evidence blobs. A failed auth tag or a plaintext hash
 * mismatch is a hard read error — never a silent fallback (§13.4).
 */
export class BlobCipher {
  constructor(private readonly keys: AssistantKeyProvider) {}

  encrypt(plaintext: Buffer): EncryptedBlob {
    const key = this.keys.getActiveKey();
    const iv = randomBytes(IV_BYTE_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key.material, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const header = Buffer.from(JSON.stringify({
      version: 1,
      algorithm: 'AES-256-GCM',
      keyId: key.keyId,
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      plaintextSha256: createHash('sha256').update(plaintext).digest('hex'),
    }), 'utf8');
    const headerLength = Buffer.alloc(HEADER_LENGTH_BYTES);
    headerLength.writeUInt32BE(header.byteLength, 0);
    return {
      envelope: Buffer.concat([MAGIC, headerLength, header, ciphertext]),
      keyId: key.keyId,
    };
  }

  decrypt(envelope: Buffer): Buffer {
    if (envelope.byteLength < MAGIC.byteLength + HEADER_LENGTH_BYTES) {
      throw new Error('Evidence envelope is truncated.');
    }
    if (!envelope.subarray(0, MAGIC.byteLength).equals(MAGIC)) {
      throw new Error('Evidence envelope has an unrecognized magic prefix.');
    }
    const headerLength = envelope.readUInt32BE(MAGIC.byteLength);
    const headerStart = MAGIC.byteLength + HEADER_LENGTH_BYTES;
    const headerEnd = headerStart + headerLength;
    if (headerEnd > envelope.byteLength) {
      throw new Error('Evidence envelope header length exceeds the payload.');
    }

    const header = EnvelopeHeaderSchema.parse(
      JSON.parse(envelope.subarray(headerStart, headerEnd).toString('utf8')),
    );
    const key = this.keys.getKeyById(header.keyId);
    const decipher = createDecipheriv(
      ALGORITHM, key.material, Buffer.from(header.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(header.authTag, 'base64'));

    let plaintext: Buffer;
    try {
      plaintext = Buffer.concat([
        decipher.update(envelope.subarray(headerEnd)),
        decipher.final(),
      ]);
    } catch {
      throw new Error('Evidence envelope failed authentication; the blob has been tampered with.');
    }

    const actualHash = createHash('sha256').update(plaintext).digest('hex');
    if (actualHash !== header.plaintextSha256) {
      throw new Error('Evidence envelope plaintext hash mismatch; the blob has been tampered with.');
    }
    return plaintext;
  }
}