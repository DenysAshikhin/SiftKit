import {
  parseNoteBody, rewriteLinks, vaultKey,
  type VaultNote, type VaultNoteInput, type VaultNoteKind, type VaultNotePatch, type VaultRenameResult,
  type VaultRevision, type VaultRevisionSummary, type VaultWriteMeta, type VaultWriteSource,
} from '@siftkit/contracts';

import type { Clock } from '../assistant/clock.ts';
import type { IdGenerator } from '../assistant/ids.ts';
import type { RuntimeDatabase } from '../state/runtime-db.ts';
import { z } from '../lib/zod.ts';
import { VaultConflictError, VaultNotFoundError, VaultTitleTakenError, VaultValidationError } from './errors.ts';
import { NoteIdRowSchema, VaultRevisionRowSchema, readVaultNote, requireVaultNote, toVaultRevision } from './note-rows.ts';

const TITLE_MAX_LENGTH = 200;
const TITLE_FORBIDDEN = /[[\]|#^\\/:*?"<>]/;
/** Rows rebuilt from a note on every write, keyed by the column that names the note. */
const DERIVED_TABLES = [['vault_links', 'from_note_id'], ['vault_aliases', 'note_id'], ['vault_tags', 'note_id']] as const;
const IdRowSchema = z.object({ id: z.string() });

export function validateVaultTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0 || trimmed.length > TITLE_MAX_LENGTH || TITLE_FORBIDDEN.test(trimmed)) {
    throw new VaultValidationError(`Invalid note title: ${JSON.stringify(title)}`);
  }
  return trimmed;
}

/** Free text made safe for a title: forbidden characters become spaces. May return an empty string. */
export function sanitizeVaultTitle(text: string): string {
  return text.replace(new RegExp(TITLE_FORBIDDEN.source, 'g'), ' ').replace(/\s+/g, ' ').trim();
}

function normalizeFolder(folder: string): string {
  const parts = folder.split('/').map((part) => part.trim()).filter((part) => part.length > 0);
  for (const part of parts) {
    if (TITLE_FORBIDDEN.test(part)) throw new VaultValidationError(`Invalid folder: ${JSON.stringify(folder)}`);
  }
  return parts.join('/');
}

function uniqueKeyed(values: readonly string[], exclude: string | null): string[] {
  const seen = new Set<string>(exclude === null ? [] : [vaultKey(exclude)]);
  const kept: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(vaultKey(trimmed))) continue;
    seen.add(vaultKey(trimmed));
    kept.push(trimmed);
  }
  return kept;
}

export function computeIsStub(kind: VaultNoteKind, body: string): boolean {
  if (kind !== 'entity') return false;
  const parsed = parseNoteBody(body);
  return parsed.factRows.length === 0 && parsed.tasks.length === 0 && parsed.unverified.length === 0;
}

/** The only writer of vault notes. Every write is one transaction: note row, revision snapshot, derived indexes. */
export class VaultNoteStore {
  private readonly database: RuntimeDatabase;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(database: RuntimeDatabase, clock: Clock, ids: IdGenerator) {
    this.database = database;
    this.clock = clock;
    this.ids = ids;
  }

  create(input: VaultNoteInput, meta: VaultWriteMeta): VaultNote {
    return this.database.transaction((): VaultNote => {
      const title = validateVaultTitle(input.title);
      if (this.findIdByTitleKey(vaultKey(title)) !== null) throw new VaultTitleTakenError(title);
      const now = this.clock.nowUtc();
      const note: VaultNote = {
        id: this.ids.next('vnote'),
        title,
        folder: normalizeFolder(input.folder),
        kind: input.kind,
        types: uniqueKeyed(input.types, null),
        aliases: uniqueKeyed(input.aliases, title),
        tags: uniqueKeyed(input.tags.map((tag) => tag.toLowerCase()), null),
        body: input.body,
        revision: 1,
        isStub: computeIsStub(input.kind, input.body),
        createdAtUtc: now,
        updatedAtUtc: now,
      };
      this.database.prepare(`
        INSERT INTO vault_notes (id, title, title_key, folder, kind, types_json, aliases_json, tags_json,
          body, revision, is_stub, created_at_utc, updated_at_utc)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(note.id, note.title, vaultKey(note.title), note.folder, note.kind, JSON.stringify(note.types),
        JSON.stringify(note.aliases), JSON.stringify(note.tags), note.body, note.revision, note.isStub ? 1 : 0,
        note.createdAtUtc, note.updatedAtUtc);
      this.writeRevision(note, meta);
      this.reindex(note);
      return note;
    })();
  }

  /** `base`, or `base 2`, `base 3`... when a note already answers to it. */
  availableTitle(base: string): string {
    let title = base;
    for (let suffix = 2; this.resolveId(title) !== null; suffix += 1) title = `${base} ${suffix}`;
    return title;
  }

  resolveId(titleOrAlias: string): string | null {
    const row = this.database.prepare('SELECT note_id FROM vault_key_owners WHERE key = ?').get(vaultKey(titleOrAlias));
    return row === undefined ? null : NoteIdRowSchema.parse(row).note_id;
  }

  resolve(titleOrAlias: string): VaultNote | null {
    const id = this.resolveId(titleOrAlias);
    return id === null ? null : readVaultNote(this.database, id);
  }

  listRevisions(id: string): VaultRevisionSummary[] {
    requireVaultNote(this.database, id);
    return z.array(VaultRevisionRowSchema.pick({ revision: true, actor: true, summary: true, source_ref: true, created_at_utc: true })).parse(
      this.database.prepare('SELECT revision, actor, summary, source_ref, created_at_utc FROM vault_note_revisions WHERE note_id = ? ORDER BY revision DESC').all(id),
    ).map((row) => ({ revision: row.revision, actor: row.actor, summary: row.summary, sourceRef: row.source_ref, createdAtUtc: row.created_at_utc }));
  }

  getRevision(id: string, revision: number): VaultRevision {
    const row = this.database.prepare('SELECT * FROM vault_note_revisions WHERE note_id = ? AND revision = ?').get(id, revision);
    if (row === undefined) throw new VaultNotFoundError(`${id} revision ${revision}`);
    return toVaultRevision(VaultRevisionRowSchema.parse(row));
  }

  update(id: string, patch: VaultNotePatch, expectedRevision: number, meta: VaultWriteMeta): VaultNote {
    return this.database.transaction((): VaultNote => {
      const current = this.requireRevision(id, expectedRevision);
      const body = patch.body ?? current.body;
      const next: VaultNote = {
        ...current,
        body,
        folder: patch.folder === undefined ? current.folder : normalizeFolder(patch.folder),
        types: patch.types === undefined ? current.types : uniqueKeyed(patch.types, null),
        aliases: uniqueKeyed(patch.aliases ?? current.aliases, current.title),
        tags: patch.tags === undefined ? current.tags : uniqueKeyed(patch.tags.map((tag) => tag.toLowerCase()), null),
        isStub: computeIsStub(current.kind, body),
      };
      return this.persist(current, next, meta);
    })();
  }

  restore(id: string, revision: number, expectedRevision: number, source: VaultWriteSource): VaultNote {
    return this.database.transaction((): VaultNote => {
      const current = this.requireRevision(id, expectedRevision);
      const snapshot = this.getRevision(id, revision);
      // Title is not restored: renaming rewrites other notes and stays an explicit action.
      return this.persist(current, {
        ...current,
        body: snapshot.body,
        folder: snapshot.folder,
        types: snapshot.types,
        aliases: uniqueKeyed(snapshot.aliases, current.title),
        tags: snapshot.tags,
        isStub: computeIsStub(current.kind, snapshot.body),
      }, { ...source, summary: `Restored revision ${revision}` });
    })();
  }

  rename(id: string, newTitle: string, expectedRevision: number, source: VaultWriteSource): VaultRenameResult {
    return this.database.transaction((): VaultRenameResult => {
      const current = this.requireRevision(id, expectedRevision);
      const title = validateVaultTitle(newTitle);
      const owner = this.findIdByTitleKey(vaultKey(title));
      if (owner !== null && owner !== id) throw new VaultTitleTakenError(title);
      let rewrittenNotes = 0;
      let rewrittenLinks = 0;
      const inbound = z.array(z.object({ from_note_id: z.string() })).parse(this.database.prepare(
        'SELECT DISTINCT from_note_id FROM vault_links WHERE target_key = ? AND from_note_id <> ?',
      ).all(vaultKey(current.title), id));
      for (const { from_note_id: fromId } of inbound) {
        const linking = requireVaultNote(this.database, fromId);
        const rewritten = rewriteLinks(linking.body, current.title, title);
        if (rewritten.count === 0) continue;
        this.persist(linking, { ...linking, body: rewritten.body }, {
          actor: source.actor, summary: `Link updated: ${current.title} → ${title}`, sourceRef: id,
        });
        rewrittenNotes += 1;
        rewrittenLinks += rewritten.count;
      }
      const note = this.persist(current, {
        ...current, title, aliases: uniqueKeyed([current.title, ...current.aliases], title),
      }, { ...source, summary: `Renamed from ${current.title}` });
      return { note, rewrittenNotes, rewrittenLinks };
    })();
  }

  /** Revisions and derived rows go with the note through ON DELETE CASCADE; the fts5 row is deleted explicitly. */
  delete(id: string, expectedRevision: number): void {
    this.database.transaction(() => {
      this.requireRevision(id, expectedRevision);
      this.database.prepare('DELETE FROM vault_notes_fts WHERE note_id = ?').run(id);
      this.database.prepare('DELETE FROM vault_notes WHERE id = ?').run(id);
    })();
  }

  private requireRevision(id: string, expectedRevision: number): VaultNote {
    const current = requireVaultNote(this.database, id);
    if (current.revision !== expectedRevision) throw new VaultConflictError(id, current.revision);
    return current;
  }

  /** Writes `next` as a new revision unless nothing changed. Callers run inside a transaction. */
  private persist(current: VaultNote, next: VaultNote, meta: VaultWriteMeta): VaultNote {
    const unchanged = current.title === next.title && current.body === next.body && current.folder === next.folder
      && JSON.stringify([current.types, current.aliases, current.tags]) === JSON.stringify([next.types, next.aliases, next.tags]);
    if (unchanged) return current;
    const written: VaultNote = { ...next, revision: current.revision + 1, updatedAtUtc: this.clock.nowUtc() };
    this.database.prepare(`
      UPDATE vault_notes SET title = ?, title_key = ?, folder = ?, types_json = ?, aliases_json = ?, tags_json = ?,
        body = ?, revision = ?, is_stub = ?, updated_at_utc = ?
      WHERE id = ?
    `).run(written.title, vaultKey(written.title), written.folder, JSON.stringify(written.types),
      JSON.stringify(written.aliases), JSON.stringify(written.tags), written.body, written.revision,
      written.isStub ? 1 : 0, written.updatedAtUtc, written.id);
    this.writeRevision(written, meta);
    this.reindex(written);
    return written;
  }

  private findIdByTitleKey(key: string): string | null {
    const row = this.database.prepare('SELECT id FROM vault_notes WHERE title_key = ?').get(key);
    return row === undefined ? null : IdRowSchema.parse(row).id;
  }

  private writeRevision(note: VaultNote, meta: VaultWriteMeta): void {
    this.database.prepare(`
      INSERT INTO vault_note_revisions (note_id, revision, actor, summary, source_ref, title, folder, body,
        types_json, aliases_json, tags_json, created_at_utc)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(note.id, note.revision, meta.actor, meta.summary, meta.sourceRef, note.title, note.folder, note.body,
      JSON.stringify(note.types), JSON.stringify(note.aliases), JSON.stringify(note.tags), note.updatedAtUtc);
  }

  private reindex(note: VaultNote): void {
    for (const [table, column] of DERIVED_TABLES) this.database.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(note.id);
    const parsed = parseNoteBody(note.body);
    const insertLink = this.database.prepare('INSERT INTO vault_links (from_note_id, target_key, row_label, line) VALUES (?, ?, ?, ?)');
    for (const link of parsed.links) {
      if (!link.embed) insertLink.run(note.id, vaultKey(link.target), link.rowLabel, link.line);
    }
    const insertAlias = this.database.prepare('INSERT OR IGNORE INTO vault_aliases (alias_key, note_id) VALUES (?, ?)');
    for (const alias of note.aliases) insertAlias.run(vaultKey(alias), note.id);
    const insertTag = this.database.prepare('INSERT OR IGNORE INTO vault_tags (note_id, tag) VALUES (?, ?)');
    for (const tag of new Set([...note.tags, ...parsed.tags].map((value) => value.toLowerCase()))) insertTag.run(note.id, tag);
    this.database.prepare('DELETE FROM vault_notes_fts WHERE note_id = ?').run(note.id);
    this.database.prepare('INSERT INTO vault_notes_fts (note_id, title, aliases, body) VALUES (?, ?, ?, ?)')
      .run(note.id, note.title, note.aliases.join(' '), note.body);
  }
}
