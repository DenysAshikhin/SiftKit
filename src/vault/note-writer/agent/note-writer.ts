import {
  ImageDataUrlSchema, appendSectionLines, insertSectionLines, removeCallouts, replaceSection, sectionLines,
  type ImageDataUrl, type VaultNote, type VaultWriteMeta,
} from '@siftkit/contracts';

import type { Clock } from '../../../assistant/clock.ts';
import type { SecretScanner } from '../../../assistant/domain/secrets.ts';
import { isUsableCapability, type AssistantImageCapabilityProvider } from '../../../assistant/images/image-capability.ts';
import type { AssistantInferenceClient } from '../../../assistant/inference/client.ts';
import type { AuditStore } from '../../../assistant/storage/audit-store.ts';
import type { RuntimeDatabase } from '../../../state/runtime-db.ts';
import type { VaultAttachments } from '../../attachments.ts';
import { finishCapture, requireCapture, setCaptureState, type VaultCaptureRow } from '../../captures.ts';
import { VaultNotFoundError } from '../../errors.ts';
import { stampValidated } from '../../fact-points.ts';
import { NoteIdRowSchema, requireVaultNote } from '../../note-rows.ts';
import { sanitizeVaultTitle, type VaultNoteStore } from '../../note-store.ts';
import { markRollupDay } from '../../rollup-days.ts';
import type { VaultValidationQueue } from '../../validation-queue.ts';
import { CHATS_FOLDER, LEARNED_HEADING, PENDING_CALLOUT_KIND } from '../../vault-layout.ts';
import { localDay } from '../../vault-time.ts';
import type { VaultChatTurn } from '../chat-turn.ts';
import { SUPPRESSION_PATTERN, stripUntrustedSpans } from '../chat-text.ts';
import type { VaultEditApplier } from '../edit-applier.ts';
import { candidateCards, ownerCard, reviewCards } from './cards.ts';
import { writerSystemPrompt, type VaultWriterSourceKind } from './prompt.ts';
import { VaultWriterSession, type VaultWriterSessionOutcome } from './session.ts';
import { VaultWriterTools } from './tools.ts';
import type { VaultWriterJob } from './writer-job.ts';

const UNTITLED_SESSION = 'Untitled';
const SCREENSHOT_ACTOR = 'note-writer · screenshot';
const TRANSCRIPT_HEADING = 'Transcript';
const WITHHELD = '_Withheld: the message contained credential material._';
/** Message lines that would otherwise parse as vault structure: headings and callouts. */
const STRUCTURAL_LINE = /^(#{1,6}\s|> \[!)/;

export type VaultNoteWriterSkip = 'awaiting_capability' | 'already_processed' | 'suppressed' | 'invalid_review';

/** `written` committed vault changes, so the runner follows with maintenance. */
export type VaultNoteWriterOutcome = { readonly kind: 'written' } | { readonly kind: 'skipped'; readonly reason: VaultNoteWriterSkip };

export interface VaultNoteWriterOptions {
  readonly database: RuntimeDatabase;
  readonly store: VaultNoteStore;
  readonly attachments: VaultAttachments;
  readonly applier: VaultEditApplier;
  readonly audit: AuditStore;
  readonly scanner: SecretScanner;
  readonly clock: Clock;
  readonly inference: AssistantInferenceClient;
  readonly capability: AssistantImageCapabilityProvider;
  readonly queue: VaultValidationQueue;
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

type AgentOutcome = Exclude<VaultWriterSessionOutcome, { kind: 'aborted' }>;

const WRITTEN: VaultNoteWriterOutcome = { kind: 'written' };
const skipped = (reason: VaultNoteWriterSkip): VaultNoteWriterOutcome => ({ kind: 'skipped', reason });
const escapeStructure = (text: string) => text.split('\n').map((line) => (STRUCTURAL_LINE.test(line) ? `\\${line}` : line));

/**
 * The single note-writer: runs the agent over a capture, chat turn or review batch, applies its
 * edits, then does that source's bookkeeping. Nothing is written before the agent finishes.
 */
export class VaultNoteWriter {
  private readonly database: RuntimeDatabase;
  private readonly store: VaultNoteStore;
  private readonly attachments: VaultAttachments;
  private readonly applier: VaultEditApplier;
  private readonly audit: AuditStore;
  private readonly scanner: SecretScanner;
  private readonly clock: Clock;
  private readonly inference: AssistantInferenceClient;
  private readonly capability: AssistantImageCapabilityProvider;
  private readonly queue: VaultValidationQueue;

  constructor(options: VaultNoteWriterOptions) {
    this.database = options.database;
    this.store = options.store;
    this.attachments = options.attachments;
    this.applier = options.applier;
    this.audit = options.audit;
    this.scanner = options.scanner;
    this.clock = options.clock;
    this.inference = options.inference;
    this.capability = options.capability;
    this.queue = options.queue;
  }

  async run(ownerId: string, job: VaultWriterJob, signal: AbortSignal): Promise<VaultNoteWriterOutcome> {
    switch (job.source) {
      case 'capture': return this.capture(ownerId, job.attachmentId, signal);
      case 'chat': return this.chat(ownerId, job.turn, signal);
      case 'review': return this.review(ownerId, job.noteIds, signal);
    }
  }

  /** Capability is read at admission and again before dispatch, so a reloaded runtime sends the capture back to wait. */
  private async capture(ownerId: string, attachmentId: string, signal: AbortSignal): Promise<VaultNoteWriterOutcome> {
    const capture = requireCapture(this.database, attachmentId);
    if (capture.processed_at_utc !== null) return skipped('already_processed');
    const admission = this.capability.read();
    if (!isUsableCapability(admission)) return this.awaitCapability(attachmentId);
    setCaptureState(this.database, attachmentId, 'processing');
    const day = localDay(capture.captured_at_utc);
    const image = this.readImage(capture);
    // Retention may have deleted the file first; retrying cannot bring it back, so this is terminal.
    if (image === null) {
      this.finishCapture(capture, [], 'image_removed');
      return WRITTEN;
    }
    if (this.capability.read().instanceId !== admission.instanceId) return this.awaitCapability(attachmentId);

    const source = [
      '## Source: screenshot (attached)', `App: ${capture.app}`, ...(capture.window_title === null ? [] : [`Window title: ${capture.window_title}`]),
    ].join('\n');
    const outcome = await this.agent('capture', this.seed(`${capture.app} ${capture.window_title ?? ''}`, source), [image], day, signal);
    this.database.transaction(() => {
      let learned: readonly string[] = [];
      if (outcome.kind === 'invalid_output') {
        this.rejectAudit(ownerId, 'vault_capture', attachmentId, 'Screenshot note-writer submitted no edits.', outcome);
      } else {
        const note = requireVaultNote(this.database, capture.note_id);
        learned = this.applier.apply({
          ownerId, operations: outcome.operations, actor: SCREENSHOT_ACTOR, sourceRef: attachmentId, summary: `Screenshot ${note.title}`, scopeNoteIds: [],
        }).learned;
      }
      this.finishCapture(capture, learned, 'processed');
    })();
    return WRITTEN;
  }

  /** The model runs before anything is written or audited, so a job that throws mid-call retries cleanly. */
  private async chat(ownerId: string, turn: VaultChatTurn, signal: AbortSignal): Promise<VaultNoteWriterOutcome> {
    if (SUPPRESSION_PATTERN.test(turn.userText)) {
      this.audit.recordAuditEvent({
        ownerId, eventType: 'turn_suppressed_by_user', targetType: 'chat_session', targetId: turn.sessionId,
        summary: 'User asked not to remember this turn; nothing was written.', details: { messageId: turn.userMessageId },
      });
      return skipped('suppressed');
    }
    const user = this.message('user', turn.userText);
    const assistant = this.message('assistant', turn.assistantText);
    const sourceRef = `${turn.sessionId}:${turn.userMessageId}`;
    const day = localDay(turn.capturedAtUtc);
    // Only the user's own words can state a fact about the user; without them there is nothing to ask.
    const outcome = user.visible.length === 0 ? null : await this.agent('chat', this.seed(user.visible, [
      '## Source: chat turn', `The user wrote:\n${user.visible}`, '', `The assistant replied:\n${assistant.visible}`,
    ].join('\n')), [], day, signal);

    this.database.transaction(() => {
      for (const message of [user, assistant]) {
        if (message.withheldRuleIds === null) continue;
        this.audit.recordAuditEvent({
          ownerId, eventType: 'chat_message_withheld', targetType: 'chat_session', targetId: turn.sessionId,
          summary: 'A chat message contained credential material and was not recorded.', details: { role: message.role, ruleIds: [...message.withheldRuleIds] },
        });
      }
      if (outcome?.kind === 'invalid_output') this.rejectAudit(ownerId, 'chat_session', turn.sessionId, 'Chat note-writer submitted no edits.', outcome);
      const meta: VaultWriteMeta = { actor: 'note-writer · chat', summary: `Chat turn in ${turn.sessionTitle}`, sourceRef };
      const learned = outcome?.kind === 'submitted'
        ? this.applier.apply({ ownerId, operations: outcome.operations, actor: meta.actor, sourceRef, summary: meta.summary, scopeNoteIds: [] }).learned
        : [];
      const existing = this.chatNote(turn.sessionId, day);
      const base = existing?.body ?? `## ${TRANSCRIPT_HEADING}\n\n## ${LEARNED_HEADING}`;
      const entries = [user, assistant].flatMap((message) => ['', `#### ${message.role === 'user' ? 'You' : 'Assistant'}`, ...escapeStructure(message.transcript)]);
      // The first entry sits right under the heading; later ones are separated by a blank line.
      const transcript = sectionLines(base, TRANSCRIPT_HEADING)?.length ? entries : entries.slice(1);
      const body = appendSectionLines(insertSectionLines(base, TRANSCRIPT_HEADING, transcript), LEARNED_HEADING, learned);
      if (existing === null) this.createChatNote(turn, day, body, meta);
      else this.store.update(existing.id, { body }, existing.revision, meta);
      markRollupDay(this.database, day);
    })();
    return WRITTEN;
  }

  /** A committed review stamps the batch validated, except the values it doubted; a failed one stamps nothing. */
  private async review(ownerId: string, noteIds: readonly string[], signal: AbortSignal): Promise<VaultNoteWriterOutcome> {
    const nowUtc = this.clock.nowUtc();
    const seed = [ownerCard(this.database, nowUtc), '## Notes to review', reviewCards(this.database, this.queue, noteIds, nowUtc)].join('\n\n');
    const outcome = await this.agent('review', seed, [], localDay(nowUtc), signal);
    if (outcome.kind === 'invalid_output') {
      this.rejectAudit(ownerId, 'vault_review', noteIds.join(','), 'Review pass submitted no edits.', outcome);
      return skipped('invalid_review');
    }
    this.database.transaction(() => {
      const result = this.applier.apply({
        ownerId, operations: outcome.operations, actor: 'note-writer · review', sourceRef: 'review', summary: 'Review pass', scopeNoteIds: noteIds,
      });
      const validatedAt = this.clock.nowUtc();
      for (const id of noteIds) stampValidated(this.database, id, result.flagged.filter((point) => point.noteId === id), validatedAt);
    })();
    return WRITTEN;
  }

  /** Runs the agent; an abort throws before anything is written, so the runner re-queues the job. */
  private async agent(source: VaultWriterSourceKind, seedText: string, images: readonly ImageDataUrl[], day: string, signal: AbortSignal): Promise<AgentOutcome> {
    const outcome = await new VaultWriterSession({
      systemPrompt: writerSystemPrompt(source), seedText, images, inference: this.inference, abortSignal: signal,
      tools: new VaultWriterTools({ database: this.database, store: this.store, clock: this.clock, day }),
    }).run();
    if (outcome.kind === 'aborted') throw new Error('Vault writer aborted before writing.');
    return outcome;
  }

  /** The owner card, the likely related notes for `sourceText`, then the source itself. */
  private seed(sourceText: string, source: string): string {
    const nowUtc = this.clock.nowUtc();
    return [ownerCard(this.database, nowUtc), candidateCards(this.database, sourceText, nowUtc), source].join('\n\n');
  }

  /** Audits a run that submitted no edits; the raw sample is kept only when it holds no secret. */
  private rejectAudit(ownerId: string, targetType: string, targetId: string, summary: string, outcome: Extract<AgentOutcome, { kind: 'invalid_output' }>): void {
    const scan = this.scanner.scan(outcome.rawSample);
    this.audit.recordAuditEvent({
      ownerId, eventType: 'vault_writer_rejected', targetType, targetId, summary,
      details: {
        code: 'invalid_output', turns: outcome.trace.turns,
        rawSample: scan.containsSecret ? null : outcome.rawSample,
        ...(scan.containsSecret ? { rawSampleWithheld: [...scan.matchedRuleIds] } : {}),
      },
    });
  }

  private awaitCapability(attachmentId: string): VaultNoteWriterOutcome {
    setCaptureState(this.database, attachmentId, 'awaiting_image_capability');
    return skipped('awaiting_capability');
  }

  private readImage(capture: VaultCaptureRow): ImageDataUrl | null {
    try {
      const { mimeType, bytes } = this.attachments.read(this.attachments.require(capture.attachment_id).relativePath);
      return ImageDataUrlSchema.parse(`data:${mimeType};base64,${bytes.toString('base64')}`);
    } catch (error) {
      if (error instanceof VaultNotFoundError) return null;
      throw error;
    }
  }

  /** Swaps the pending callout for `## Learned` (empty on failure), closes the capture and queues its day's rollup. */
  private finishCapture(capture: VaultCaptureRow, learned: readonly string[], state: 'processed' | 'image_removed'): void {
    this.database.transaction(() => {
      const note = requireVaultNote(this.database, capture.note_id);
      const meta: VaultWriteMeta = { actor: SCREENSHOT_ACTOR, summary: 'Learned from screenshot', sourceRef: capture.attachment_id };
      this.store.update(note.id, { body: replaceSection(removeCallouts(note.body, PENDING_CALLOUT_KIND), LEARNED_HEADING, learned) }, note.revision, meta);
      finishCapture(this.database, capture.attachment_id, state, this.clock.nowUtc());
      markRollupDay(this.database, localDay(capture.captured_at_utc));
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
