import { appendSectionLines, insertSectionLines, sectionLines, type VaultNote, type VaultWriteMeta } from '@siftkit/contracts';

import type { SecretScanner } from '../../assistant/domain/secrets.ts';
import type { StructuredOutputRunner } from '../../assistant/inference/structured-runner.ts';
import { QueryIntentExtractor } from '../../assistant/retrieval/query-intent.ts';
import type { AuditStore } from '../../assistant/storage/audit-store.ts';
import { z } from '../../lib/zod.ts';
import type { RuntimeDatabase } from '../../state/runtime-db.ts';
import { NoteIdRowSchema, requireVaultNote } from '../note-rows.ts';
import { sanitizeVaultTitle, type VaultNoteStore } from '../note-store.ts';
import { CHATS_FOLDER, LEARNED_HEADING } from '../vault-layout.ts';
import { localDay } from '../vault-time.ts';
import { knownNotesText } from './candidates.ts';
import { SUPPRESSION_PATTERN, stripUntrustedSpans } from './chat-text.ts';
import type { VaultEditApplier } from './edit-applier.ts';
import { VAULT_EDIT_INSTRUCTIONS, VaultEditResponseSchema } from './edit-ops.ts';
import { outputRejectionDetails } from './rejections.ts';

const UNTITLED_SESSION = 'Untitled';
const TRANSCRIPT_HEADING = 'Transcript';
const WITHHELD = '_Withheld: the message contained credential material._';
/** Message lines that would otherwise parse as vault structure: headings and callouts. */
const STRUCTURAL_LINE = /^(#{1,6}\s|> \[!)/;
const INSTRUCTIONS = [
  'Below is one chat turn between the user and their assistant. Record durable facts the user states',
  'about themselves: tools, projects, people, places, plans, preferences and corrections to earlier facts.',
  "Skip questions, hypotheticals, quotations and requests. The assistant's reply is context only.",
  VAULT_EDIT_INSTRUCTIONS,
].join('\n');

export const VaultChatTurnSchema = z.object({
  sessionId: z.string(),
  sessionTitle: z.string(),
  userMessageId: z.string(),
  capturedAtUtc: z.string().datetime(),
  userText: z.string(),
  /** The final answer only; hidden reasoning is never passed in. */
  assistantText: z.string(),
}).strict();
export type VaultChatTurn = z.infer<typeof VaultChatTurnSchema>;

export type VaultChatWriteOutcome =
  | { readonly kind: 'processed'; readonly noteId: string; readonly learned: readonly string[]; readonly touchedNoteIds: readonly string[] }
  | { readonly kind: 'rejected'; readonly noteId: string; readonly reason: 'invalid_output' }
  | { readonly kind: 'suppressed' };

export interface VaultChatWriterOptions {
  readonly database: RuntimeDatabase;
  readonly store: VaultNoteStore;
  readonly applier: VaultEditApplier;
  readonly audit: AuditStore;
  readonly scanner: SecretScanner;
  readonly runner: StructuredOutputRunner;
}

interface Message {
  readonly role: 'user' | 'assistant';
  /** What the transcript keeps: the text, or the withheld marker. */
  readonly transcript: string;
  /** What the model sees: trusted text only, empty when withheld. */
  readonly visible: string;
  /** Secret rules that withheld the message, or `null` when it was kept. */
  readonly withheldRuleIds: readonly string[] | null;
}

const escapeStructure = (text: string) => text.split('\n').map((line) => (STRUCTURAL_LINE.test(line) ? `\\${line}` : line));

/**
 * Turns one chat turn into the day's chat note and vault edits (design §4.2). The model runs before
 * anything is written or audited, so a job that throws mid-call can be retried without duplicates.
 */
export class VaultChatWriter {
  private readonly database: RuntimeDatabase;
  private readonly store: VaultNoteStore;
  private readonly applier: VaultEditApplier;
  private readonly audit: AuditStore;
  private readonly scanner: SecretScanner;
  private readonly runner: StructuredOutputRunner;

  constructor(options: VaultChatWriterOptions) {
    this.database = options.database;
    this.store = options.store;
    this.applier = options.applier;
    this.audit = options.audit;
    this.scanner = options.scanner;
    this.runner = options.runner;
  }

  async run(ownerId: string, turn: VaultChatTurn, abortSignal: AbortSignal | null): Promise<VaultChatWriteOutcome> {
    if (SUPPRESSION_PATTERN.test(turn.userText)) {
      this.audit.recordAuditEvent({
        ownerId, eventType: 'turn_suppressed_by_user', targetType: 'chat_session', targetId: turn.sessionId,
        summary: 'User asked not to remember this turn; nothing was written.', details: { messageId: turn.userMessageId },
      });
      return { kind: 'suppressed' };
    }
    const user = this.message('user', turn.userText);
    const assistant = this.message('assistant', turn.assistantText);
    const sourceRef = `${turn.sessionId}:${turn.userMessageId}`;

    // Only the user's own words can state a fact about the user; without them there is nothing to ask.
    const outcome = user.visible.length === 0 ? null : await this.runner.run({
      role: 'vault_chat_writer', instructions: INSTRUCTIONS, schemaName: 'vault_chat_edits', schema: VaultEditResponseSchema, abortSignal,
      userText: [
        knownNotesText(this.database, new QueryIntentExtractor().extract(user.visible).terms),
        '', `The user wrote:\n${user.visible}`, '', `The assistant replied:\n${assistant.visible}`,
      ].join('\n'),
    });

    return this.database.transaction((): VaultChatWriteOutcome => {
      for (const message of [user, assistant]) {
        if (message.withheldRuleIds === null) continue;
        this.audit.recordAuditEvent({
          ownerId, eventType: 'chat_message_withheld', targetType: 'chat_session', targetId: turn.sessionId,
          summary: 'A chat message contained credential material and was not recorded.', details: { role: message.role, ruleIds: [...message.withheldRuleIds] },
        });
      }
      if (outcome?.ok === false) {
        this.audit.recordAuditEvent({
          ownerId, eventType: 'vault_writer_rejected', targetType: 'chat_session', targetId: turn.sessionId,
          summary: 'Chat note-writer produced no usable structured output.', details: outputRejectionDetails(this.scanner, outcome),
        });
      }
      const meta: VaultWriteMeta = { actor: 'note-writer · chat', summary: `Chat turn in ${turn.sessionTitle}`, sourceRef };
      const result = outcome?.ok === true
        ? this.applier.apply({ ownerId, operations: outcome.value.operations, actor: 'note-writer · chat', sourceRef, summary: meta.summary })
        : { learned: [], touchedNoteIds: [] };
      const day = localDay(turn.capturedAtUtc);
      const existing = this.chatNote(turn.sessionId, day);
      const base = existing?.body ?? `## ${TRANSCRIPT_HEADING}\n\n## ${LEARNED_HEADING}`;
      const entries = [user, assistant].flatMap((message) => ['', `#### ${message.role === 'user' ? 'You' : 'Assistant'}`, ...escapeStructure(message.transcript)]);
      // The first entry sits right under the heading; later ones are separated by a blank line.
      const transcript = sectionLines(base, TRANSCRIPT_HEADING)?.length ? entries : entries.slice(1);
      const body = appendSectionLines(insertSectionLines(base, TRANSCRIPT_HEADING, transcript), LEARNED_HEADING, result.learned);
      const note = existing === null
        ? this.createChatNote(turn, day, body, meta)
        : this.store.update(existing.id, { body }, existing.revision, meta);
      return outcome?.ok === false
        ? { kind: 'rejected', noteId: note.id, reason: 'invalid_output' }
        : { kind: 'processed', noteId: note.id, learned: result.learned, touchedNoteIds: result.touchedNoteIds };
    })();
  }

  private message(role: Message['role'], text: string): Message {
    const scan = this.scanner.scan(text);
    return scan.containsSecret
      ? { role, transcript: WITHHELD, visible: '', withheldRuleIds: scan.matchedRuleIds }
      : { role, transcript: text.trim(), visible: stripUntrustedSpans(text), withheldRuleIds: null };
  }

  /** The session's chat note for a local day, or `null` before its first turn. */
  private chatNote(sessionId: string, day: string): VaultNote | null {
    const row = this.database.prepare('SELECT note_id FROM vault_chat_notes WHERE session_id = ? AND day = ?').get(sessionId, day);
    return row === undefined ? null : requireVaultNote(this.database, NoteIdRowSchema.parse(row).note_id);
  }

  private createChatNote(turn: VaultChatTurn, day: string, body: string, meta: VaultWriteMeta): VaultNote {
    const note = this.store.create({
      title: this.store.availableTitle(`Chat ${day} · ${sanitizeVaultTitle(turn.sessionTitle) || UNTITLED_SESSION}`),
      folder: CHATS_FOLDER, kind: 'chat', types: [], aliases: [], tags: [], body,
    }, meta);
    this.database.prepare('INSERT INTO vault_chat_notes (session_id, day, note_id) VALUES (?, ?, ?)').run(turn.sessionId, day, note.id);
    return note;
  }
}
