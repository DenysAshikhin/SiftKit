import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { DpapiUnavailableError, type DataProtector } from '../../src/assistant/crypto/dpapi.js';

const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * DPAPI stand-in: authenticated encryption under a key only this instance holds, so tampered
 * bytes or another instance's output fail closed exactly like another Windows account would.
 */
export class InMemoryDataProtector implements DataProtector {
  private readonly key = randomBytes(32);

  async protect(data: Buffer): Promise<Buffer> {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const sealed = Buffer.concat([cipher.update(data), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), sealed]);
  }

  async unprotect(data: Buffer): Promise<Buffer> {
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, IV_BYTES));
      decipher.setAuthTag(data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      return Buffer.concat([decipher.update(data.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
    } catch (error) {
      throw new DpapiUnavailableError(`Unprotect failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
