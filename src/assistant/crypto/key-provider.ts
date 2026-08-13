import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parseJsonText } from '../../lib/json.js';
import { z } from '../../lib/zod.js';

export interface AssistantEncryptionKey {
  readonly keyId: string;
  readonly material: Buffer;
}

/**
 * Source of the AES-256 key used for evidence blobs. Gate D adds a native OS-keychain
 * implementation; both satisfy this interface and the assistant works with either.
 */
export interface AssistantKeyProvider {
  getActiveKey(): AssistantEncryptionKey;
  getKeyById(keyId: string): AssistantEncryptionKey;
}

const KEY_BYTE_LENGTH = 32;
const KEY_FILE_MODE = 0o600;

const KeyFileSchema = z.object({
  version: z.literal(1),
  activeKeyId: z.string().min(1),
  keys: z.record(z.string(), z.string().min(1)),
});

export type KeyFile = z.infer<typeof KeyFileSchema>;

/**
 * Holds the evidence key in a `0600` JSON file under the runtime root — deliberately NOT inside
 * the runtime database, so a stolen database alone cannot decrypt evidence blobs. It does not
 * protect against an attacker who can already read the user's profile directory. The UI must say
 * so plainly (design §4.7) and must not describe the database itself as encrypted at rest.
 * Gate D adds the OS-keychain provider as a second implementation of `AssistantKeyProvider`.
 */
export class FileKeyProvider implements AssistantKeyProvider {
  constructor(private readonly keyFilePath: string) {}

  getActiveKey(): AssistantEncryptionKey {
    const file = this.ensureKeyFile();
    return this.materializeKey(file.activeKeyId, file.keys[file.activeKeyId]);
  }

  getKeyById(keyId: string): AssistantEncryptionKey {
    const file = this.readKeyFile();
    return this.materializeKey(keyId, file === null ? undefined : file.keys[keyId]);
  }

  /** The active key id without creating one — `null` when no key file exists yet. */
  peekActiveKeyId(): string | null {
    const file = this.readKeyFile();
    return file === null ? null : file.activeKeyId;
  }

  /** Every key on disk, creating the first one if the file does not exist yet. */
  exportKeyFile(): KeyFile {
    return this.ensureKeyFile();
  }

  /** Restore's landing spot for recovered key material. Replaces whatever is on disk. */
  importKeyFile(activeKeyId: string, keys: Readonly<Record<string, string>>): void {
    this.writeKeyFile(KeyFileSchema.parse({ version: 1, activeKeyId, keys: { ...keys } }));
  }

  /**
   * Removes the key file. Only the custody migration (after import) and the factory reset may
   * call this. Tolerates a missing file so both callers stay idempotent.
   */
  deleteKeyFile(): void {
    fs.rmSync(this.keyFilePath, { force: true });
  }

  /** The key file on disk, generating the first key set on first use. */
  private ensureKeyFile(): KeyFile {
    const existing = this.readKeyFile();
    if (existing !== null) return existing;
    const keyId = randomUUID();
    const created: KeyFile = {
      version: 1,
      activeKeyId: keyId,
      keys: { [keyId]: randomBytes(KEY_BYTE_LENGTH).toString('base64') },
    };
    this.writeKeyFile(created);
    return created;
  }

  private materializeKey(keyId: string, encoded: string | undefined): AssistantEncryptionKey {
    if (encoded === undefined) {
      throw new Error(`Evidence encryption key ${keyId} is not available.`);
    }
    const material = Buffer.from(encoded, 'base64');
    if (material.byteLength !== KEY_BYTE_LENGTH) {
      throw new Error(`Evidence encryption key ${keyId} has the wrong length.`);
    }
    return { keyId, material };
  }

  private readKeyFile(): KeyFile | null {
    if (!fs.existsSync(this.keyFilePath)) {
      return null;
    }
    return parseJsonText(fs.readFileSync(this.keyFilePath, 'utf8'), KeyFileSchema);
  }

  private writeKeyFile(contents: KeyFile): void {
    fs.mkdirSync(path.dirname(this.keyFilePath), { recursive: true });
    fs.writeFileSync(this.keyFilePath, JSON.stringify(contents), { mode: KEY_FILE_MODE });
    fs.chmodSync(this.keyFilePath, KEY_FILE_MODE);
  }
}