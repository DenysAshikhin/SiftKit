import { randomBytes } from 'node:crypto';

import type { KeyCustody, KeyCustodyState, KeyMaterialDto } from '@siftkit/contracts';

import { hashBytes } from '../domain/keys.js';
import type { EvidenceStore } from '../storage/evidence-store.js';
import { BlobCipher } from './blob-cipher.js';
import { ImportedKeyProvider } from './imported-key-provider.js';
import type { AssistantEncryptionKey, AssistantKeyProvider } from './key-provider.js';
import type { FileKeyProvider } from './key-provider.js';

/** Durable home of `Assistant.KeyCustody`. Writes must persist before the key file is deleted. */
export interface AssistantCustodyConfigPort {
  readCustody(): KeyCustody;
  writeCustody(custody: KeyCustody): void;
}

export interface KeyCustodyServiceOptions {
  readonly config: AssistantCustodyConfigPort;
  readonly fileKeys: FileKeyProvider;
  readonly imported: ImportedKeyProvider;
  readonly evidence: EvidenceStore;
  readonly ownerId: string;
}

/**
 * Reads whichever provider the configured custody mode designates. Everything downstream —
 * `BlobCipher`, the evidence store — depends only on this, so a custody flip needs no rewiring.
 */
export class CustodyDelegatingKeyProvider implements AssistantKeyProvider {
  constructor(
    private readonly config: AssistantCustodyConfigPort,
    private readonly fileKeys: FileKeyProvider,
    private readonly imported: ImportedKeyProvider,
  ) {}

  getActiveKey(): AssistantEncryptionKey {
    return this.active().getActiveKey();
  }

  getKeyById(keyId: string): AssistantEncryptionKey {
    return this.active().getKeyById(keyId);
  }

  private active(): AssistantKeyProvider {
    return this.config.readCustody() === 'desktop' ? this.imported : this.fileKeys;
  }
}

/**
 * Owns the one-way move of the evidence key from the daemon's `0600` key file to DPAPI custody in
 * the desktop shell. Every step verifies against real stored bytes before anything is mutated: a
 * migration that deleted the key file against keys that cannot decrypt existing evidence would
 * destroy the user's memory irrecoverably.
 */
export class KeyCustodyService {
  private readonly config: AssistantCustodyConfigPort;
  private readonly fileKeys: FileKeyProvider;
  private readonly imported: ImportedKeyProvider;
  private readonly evidence: EvidenceStore;
  private readonly ownerId: string;

  constructor(options: KeyCustodyServiceOptions) {
    this.config = options.config;
    this.fileKeys = options.fileKeys;
    this.imported = options.imported;
    this.evidence = options.evidence;
    this.ownerId = options.ownerId;
  }

  status(): KeyCustodyState {
    const custody = this.config.readCustody();
    return {
      custody,
      imported: this.imported.imported,
      activeKeyId: custody === 'desktop'
        ? this.imported.activeKeyId
        : this.fileKeys.peekActiveKeyId(),
    };
  }

  /** Hands the shell the key material to seal under DPAPI. Illegal once the shell owns custody. */
  exportForShell(): KeyMaterialDto {
    if (this.config.readCustody() === 'desktop') {
      throw new Error('Evidence keys cannot be exported under desktop custody.');
    }
    const file = this.fileKeys.exportKeyFile();
    return { schemaVersion: 1, activeKeyId: file.activeKeyId, keys: { ...file.keys } };
  }

  /**
   * The shell's connect-time push. Under `'file'` custody this is the final step of the migration;
   * under `'desktop'` custody it is the idempotent re-import that follows every daemon restart.
   */
  importFromShell(material: KeyMaterialDto): KeyCustodyState {
    if (this.config.readCustody() === 'file') {
      return this.finalizeMigration(material);
    }
    this.verifyDecrypts(material);
    this.imported.import(material);
    return this.status();
  }

  /**
   * File → desktop custody. Verifies the shell round-tripped exactly the keys on disk and that they
   * still decrypt stored evidence, then imports, deletes the key file, and persists the new mode.
   * Any failure throws before the first mutation, leaving file custody intact.
   */
  finalizeMigration(material: KeyMaterialDto): KeyCustodyState {
    if (this.config.readCustody() !== 'file') {
      throw new Error('Key custody migration is only available under file custody.');
    }
    const file = this.fileKeys.exportKeyFile();
    const onDisk = Object.keys(file.keys).sort();
    const offered = Object.keys(material.keys).sort();
    if (material.activeKeyId !== file.activeKeyId
      || onDisk.length !== offered.length
      || onDisk.some((keyId, index) => keyId !== offered[index])) {
      throw new Error('Imported key ids do not match the evidence key file.');
    }
    this.verifyDecrypts(material);

    this.imported.import(material);
    this.fileKeys.deleteKeyFile();
    this.config.writeCustody('desktop');
    return this.status();
  }

  /**
   * Proves the offered material can read what is already stored. With no evidence yet there is
   * nothing to read, so a cipher round trip stands in — enough to catch corrupt key bytes.
   */
  private verifyDecrypts(material: KeyMaterialDto): void {
    const candidate = new ImportedKeyProvider();
    candidate.import(material);
    const cipher = new BlobCipher(candidate);

    const blob = this.evidence.findLatestBlob(this.ownerId);
    if (blob === null) {
      const sample = randomBytes(64);
      if (!cipher.decrypt(cipher.encrypt(sample).envelope).equals(sample)) {
        throw new Error('Imported evidence keys failed the cipher round trip.');
      }
      return;
    }

    const plaintext = cipher.decrypt(this.evidence.readBlobEnvelope(blob));
    if (hashBytes(plaintext) !== blob.content_hash) {
      throw new Error(`Imported evidence keys decrypt blob ${blob.id} to the wrong content.`);
    }
  }
}
