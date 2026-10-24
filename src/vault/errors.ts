import { AssistantConflictError, AssistantNotFoundError } from '../assistant/errors.ts';

export class VaultNotFoundError extends AssistantNotFoundError {
  constructor(what: string) {
    super(`Vault note not found: ${what}`);
    this.name = 'VaultNotFoundError';
  }
}

export class VaultConflictError extends AssistantConflictError {
  constructor(noteId: string, currentRevision: number) {
    super(`Vault note ${noteId} changed; current revision is ${currentRevision}.`, { details: { currentRevision } });
    this.name = 'VaultConflictError';
  }
}

export class VaultTitleTakenError extends AssistantConflictError {
  constructor(title: string) {
    super(`A vault note titled "${title}" already exists.`, { code: 'title_taken' });
    this.name = 'VaultTitleTakenError';
  }
}

export class VaultValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultValidationError';
  }
}
