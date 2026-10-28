import { parseNoteBody, replaceLead, VAULT_VALUE_SEPARATOR, type VaultNote } from '@siftkit/contracts';

import type { SecretScanner } from '../../assistant/domain/secrets.ts';
import type { StructuredOutputRunner } from '../../assistant/inference/structured-runner.ts';
import type { AuditStore } from '../../assistant/storage/audit-store.ts';
import type { JsonObject } from '../../lib/json-types.ts';
import { z } from '../../lib/zod.ts';
import type { RuntimeDatabase } from '../../state/runtime-db.ts';
import { requireVaultNote } from '../note-rows.ts';
import type { VaultNoteStore } from '../note-store.ts';
import { outputRejectionDetails } from './rejections.ts';

const LEAD_MAX_LENGTH = 600;
const TIDY_ACTOR = 'note-writer · tidy';
const TidyResponseSchema = z.object({ lead: z.string().trim().min(1).max(LEAD_MAX_LENGTH) }).strict();
const INSTRUCTIONS = [
  'Rewrite the lead paragraph of one personal knowledge note from its facts and plans.',
  'Write one to three plain sentences: no headings, lists, bold labels or quotes. Keep [[links]] where they help.',
  'When the note is about the user, address them as "you".',
  'Answer with {"lead": "..."}.',
].join('\n');

export type VaultTidyOutcome =
  | { readonly kind: 'tidied' }
  | { readonly kind: 'skipped'; readonly reason: 'not_entity' | 'no_facts' | 'unchanged' }
  | { readonly kind: 'rejected'; readonly reason: 'invalid_output' | 'invalid_lead' | 'secret' };

export interface VaultTidyPassOptions {
  readonly database: RuntimeDatabase;
  readonly store: VaultNoteStore;
  readonly audit: AuditStore;
  readonly scanner: SecretScanner;
  readonly runner: StructuredOutputRunner;
}

/** Rewrites one entity note's lead from its fact rows (design §4.2). Nothing but the lead changes. */
export class VaultTidyPass {
  private readonly database: RuntimeDatabase;
  private readonly store: VaultNoteStore;
  private readonly audit: AuditStore;
  private readonly scanner: SecretScanner;
  private readonly runner: StructuredOutputRunner;

  constructor(options: VaultTidyPassOptions) {
    this.database = options.database;
    this.store = options.store;
    this.audit = options.audit;
    this.scanner = options.scanner;
    this.runner = options.runner;
  }

  async run(ownerId: string, noteId: string, abortSignal: AbortSignal | null): Promise<VaultTidyOutcome> {
    const note = requireVaultNote(this.database, noteId);
    if (note.kind !== 'entity') return { kind: 'skipped', reason: 'not_entity' };
    const parsed = parseNoteBody(note.body);
    if (parsed.factRows.length === 0) return { kind: 'skipped', reason: 'no_facts' };
    // Nothing changed since the last tidy, so a new lead would only churn the history.
    if (this.store.listRevisions(noteId)[0]?.actor === TIDY_ACTOR) return { kind: 'skipped', reason: 'unchanged' };

    const outcome = await this.runner.run({
      role: 'vault_tidy', instructions: INSTRUCTIONS, userText: tidyUserText(note), schemaName: 'vault_tidy_lead', schema: TidyResponseSchema, abortSignal,
    });
    if (!outcome.ok) return this.reject(ownerId, noteId, 'invalid_output', outputRejectionDetails(this.scanner, outcome.rawSample, { code: outcome.code, attempts: outcome.attempts }));
    const lead = outcome.value.lead.replace(/\s+/g, ' ');
    const scan = this.scanner.scan(lead);
    if (scan.containsSecret) return this.reject(ownerId, noteId, 'secret', { ruleIds: [...scan.matchedRuleIds] });

    // Writers may have edited the note while the model ran; the lead goes onto the latest revision.
    return this.database.transaction((): VaultTidyOutcome => {
      const current = requireVaultNote(this.database, noteId);
      const body = replaceLead(current.body, lead);
      if (parseNoteBody(body).lead?.text !== lead) return this.reject(ownerId, noteId, 'invalid_lead', {});
      this.store.update(noteId, { body }, current.revision, { actor: TIDY_ACTOR, summary: 'Rewrote the lead', sourceRef: null });
      return { kind: 'tidied' };
    })();
  }

  private reject(ownerId: string, noteId: string, reason: 'invalid_output' | 'invalid_lead' | 'secret', details: JsonObject): VaultTidyOutcome {
    this.audit.recordAuditEvent({
      ownerId, eventType: 'vault_writer_rejected', targetType: 'vault_note', targetId: noteId,
      summary: `Tidy pass rejected: ${reason}.`, details: { reason, ...details },
    });
    return { kind: 'rejected', reason };
  }
}

function tidyUserText(note: VaultNote): string {
  const parsed = parseNoteBody(note.body);
  const plans = parsed.tasks.filter((task) => !task.done).map((task) => `- ${task.text}`);
  return [
    `Title: ${note.title}`,
    `Types: ${note.types.join(', ') || 'none'}`,
    `Current lead: ${parsed.lead?.text ?? 'none'}`,
    'Facts:', ...parsed.factRows.map((row) => `**${row.label}** ${row.values.join(VAULT_VALUE_SEPARATOR)}`),
    ...(plans.length === 0 ? [] : ['Plans:', ...plans]),
  ].join('\n');
}
