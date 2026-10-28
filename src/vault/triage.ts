import { parseNoteBody, resolveUnverified, type VaultNote, type VaultTriageRequest } from '@siftkit/contracts';

import type { RuntimeDatabase } from '../state/database-handle.ts';
import { VaultValidationError } from './errors.ts';
import { factPointKey, validateFactPoint } from './fact-points.ts';
import { requireVaultNote } from './note-rows.ts';
import type { VaultNoteStore } from './note-store.ts';

/** Keep or Drop one Review item as the user; Keep on a doubt stamps that value validated. */
export function triageUnverified(store: VaultNoteStore, database: RuntimeDatabase, noteId: string, request: VaultTriageRequest, nowUtc: string): VaultNote {
  return database.transaction((): VaultNote => {
    const note = requireVaultNote(database, noteId);
    if (!parseNoteBody(note.body).unverified.some((fact) => fact.line === request.line)) {
      throw new VaultValidationError(`Line ${request.line} is not a Review item.`);
    }
    const result = resolveUnverified(note.body, request.line, request.action);
    const written = store.update(note.id, { body: result.body }, request.expectedRevision, {
      actor: 'you', sourceRef: null, summary: request.action === 'confirm' ? 'Kept a Review item' : 'Dropped a Review item',
    });
    if (result.validated !== null) validateFactPoint(database, note.id, factPointKey(result.validated.label, result.validated.value), nowUtc);
    return written;
  })();
}
