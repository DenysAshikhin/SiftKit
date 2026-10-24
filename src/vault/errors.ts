export class VaultNotFoundError extends Error {
  constructor(what: string) {
    super(`Vault note not found: ${what}`);
    this.name = 'VaultNotFoundError';
  }
}

export class VaultConflictError extends Error {
  readonly currentRevision: number;

  constructor(noteId: string, currentRevision: number) {
    super(`Vault note ${noteId} changed; current revision is ${currentRevision}.`);
    this.name = 'VaultConflictError';
    this.currentRevision = currentRevision;
  }
}

export class VaultTitleTakenError extends Error {
  constructor(title: string) {
    super(`A vault note titled "${title}" already exists.`);
    this.name = 'VaultTitleTakenError';
  }
}

export class VaultValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultValidationError';
  }
}
