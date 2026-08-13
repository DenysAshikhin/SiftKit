import type { KeyMaterialDto } from '@siftkit/contracts';

import type { AssistantEncryptionKey, AssistantKeyProvider } from './key-provider.js';

const KEY_BYTE_LENGTH = 32;
const NOT_IMPORTED = 'No evidence key has been imported; the desktop shell holds key custody.';

interface ImportedKeys {
  readonly activeKeyId: string;
  readonly byId: ReadonlyMap<string, Buffer>;
}

/**
 * Serves the evidence key from process memory only. Under `'desktop'` custody the shell owns the
 * key at rest (DPAPI) and pushes it in over the loopback import route on every connect; the daemon
 * never writes it back to disk. Before that push lands, every read throws — a missing key must
 * surface as a hard failure, never as silently unreadable evidence.
 */
export class ImportedKeyProvider implements AssistantKeyProvider {
  private keys: ImportedKeys | null = null;

  import(material: KeyMaterialDto): void {
    const byId = new Map<string, Buffer>();
    for (const [keyId, encoded] of Object.entries(material.keys)) {
      const decoded = Buffer.from(encoded, 'base64');
      if (decoded.byteLength !== KEY_BYTE_LENGTH) {
        throw new Error(`Imported evidence key ${keyId} has the wrong length.`);
      }
      byId.set(keyId, decoded);
    }
    if (!byId.has(material.activeKeyId)) {
      throw new Error(`Imported key material omits its active key ${material.activeKeyId}.`);
    }
    this.keys = { activeKeyId: material.activeKeyId, byId };
  }

  /** The material back out, for a backup artifact. Throws rather than inventing an empty set. */
  exportMaterial(): KeyMaterialDto {
    if (this.keys === null) throw new Error(NOT_IMPORTED);
    const keys: Record<string, string> = {};
    for (const [keyId, material] of this.keys.byId) {
      keys[keyId] = material.toString('base64');
    }
    return { schemaVersion: 1, activeKeyId: this.keys.activeKeyId, keys };
  }

  clear(): void {
    if (this.keys !== null) {
      for (const material of this.keys.byId.values()) material.fill(0);
    }
    this.keys = null;
  }

  get imported(): boolean {
    return this.keys !== null;
  }

  get activeKeyId(): string | null {
    return this.keys === null ? null : this.keys.activeKeyId;
  }

  getActiveKey(): AssistantEncryptionKey {
    if (this.keys === null) throw new Error(NOT_IMPORTED);
    return this.getKeyById(this.keys.activeKeyId);
  }

  getKeyById(keyId: string): AssistantEncryptionKey {
    if (this.keys === null) throw new Error(NOT_IMPORTED);
    const material = this.keys.byId.get(keyId);
    if (material === undefined) {
      throw new Error(`Evidence encryption key ${keyId} is not available.`);
    }
    return { keyId, material };
  }
}
