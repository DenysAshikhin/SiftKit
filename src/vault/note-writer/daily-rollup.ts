import { sectionLines, vaultKey, type VaultWriteMeta } from '@siftkit/contracts';

import { z } from '../../lib/zod.ts';
import type { RuntimeDatabase } from '../../state/runtime-db.ts';
import { attachmentEmbed } from '../attachments.ts';
import { listFolderCaptures } from '../captures.ts';
import { NoteIdRowSchema, readVaultNote, readVaultNotes } from '../note-rows.ts';
import type { VaultNoteStore } from '../note-store.ts';
import { DAILY_FOLDER, LEARNED_HEADING, captureFolder } from '../vault-layout.ts';

export type VaultDailyRollupOutcome = { readonly kind: 'written'; readonly noteId: string } | { readonly kind: 'empty' };

export interface VaultDailyRollupOptions {
  readonly database: RuntimeDatabase;
  readonly store: VaultNoteStore;
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** Rebuilds one local day's daily note from that day's capture and chat notes. Deterministic, no model. */
export class VaultDailyRollup {
  private readonly database: RuntimeDatabase;
  private readonly store: VaultNoteStore;

  constructor(options: VaultDailyRollupOptions) {
    this.database = options.database;
    this.store = options.store;
  }

  run(day: string): VaultDailyRollupOutcome {
    return this.database.transaction((): VaultDailyRollupOutcome => {
      const captures = listFolderCaptures(this.database, captureFolder(day));
      const chatIds = z.array(NoteIdRowSchema).parse(this.database.prepare(`
        SELECT c.note_id FROM vault_chat_notes c JOIN vault_notes n ON n.id = c.note_id WHERE c.day = ? ORDER BY n.created_at_utc, n.id
      `).all(day)).map((row) => row.note_id);
      if (captures.length === 0 && chatIds.length === 0) return { kind: 'empty' };

      const sources = [...captures.map((capture) => capture.note_id), ...chatIds].flatMap((id) => readVaultNote(this.database, id) ?? []);
      const learned = [...new Set(sources.flatMap((note) => sectionLines(note.body, LEARNED_HEADING) ?? []))];
      const chats = sources.filter((note) => note.kind === 'chat').map((note) => `- [[${note.title}]]`);
      const body = [
        `${count(captures.length, 'screenshot')} · ${count(chats.length, 'chat')} · ${learned.length} learned`,
        ...(captures.length === 0 ? [] : ['', ...captures.map((capture) => attachmentEmbed(capture.relative_path))]),
        '', `## ${LEARNED_HEADING}`, ...learned,
        '', '## Chats', ...chats,
      ].join('\n');

      const meta: VaultWriteMeta = { actor: 'note-writer · daily', summary: `Daily rollup for ${day}`, sourceRef: null };
      // Only a daily note with exactly this title is the rollup's; a user note answering to the day stays untouched.
      const existing = readVaultNotes(this.database, "SELECT * FROM vault_notes WHERE kind = 'daily' AND title_key = ?", vaultKey(day))[0];
      const note = existing === undefined
        ? this.store.create({ title: day, folder: DAILY_FOLDER, kind: 'daily', types: [], aliases: [], tags: [], body }, meta)
        : this.store.update(existing.id, { body }, existing.revision, meta);
      return { kind: 'written', noteId: note.id };
    })();
  }
}
