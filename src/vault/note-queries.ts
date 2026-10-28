import {
  parseNoteBody, UNVERIFIED_TAG_NAME, VaultNoteKindSchema,
  type VaultBacklink, type VaultFolder, type VaultNote, type VaultNoteDetail, type VaultNoteKind, type VaultNoteSummary, type VaultOutgoing, type VaultReview, type VaultStats,
} from '@siftkit/contracts';

import type { RuntimeDatabase } from '../state/runtime-db.ts';
import { z } from '../lib/zod.ts';
import { degreeOf, loadAdjacency } from './link-graph.ts';
import { VaultNoteRowSchema, readVaultNotes, requireVaultNote, toVaultNoteSummary } from './note-rows.ts';

const SummaryRowsSchema = z.array(VaultNoteRowSchema.pick({ id: true, title: true, folder: true, kind: true, is_stub: true, updated_at_utc: true }));
const CountSchema = z.object({ count: z.number() });
/** Kinds titled by date, so a folder holding only these reads newest-first rather than most-linked-first. */
const DATED_KINDS: ReadonlySet<VaultNoteKind> = new Set(['daily', 'capture']);

function toSummary(row: z.infer<typeof SummaryRowsSchema>[number]): VaultNoteSummary {
  return { id: row.id, title: row.title, folder: row.folder, kind: row.kind, isStub: row.is_stub === 1, updatedAtUtc: row.updated_at_utc };
}

export class VaultNoteQueries {
  private readonly database: RuntimeDatabase;

  constructor(database: RuntimeDatabase) {
    this.database = database;
  }

  folders(options: { readonly includeStubs: boolean }): VaultFolder[] {
    const rows = z.array(z.object({ folder: z.string(), count: z.number() })).parse(this.database.prepare(
      `SELECT folder, COUNT(*) AS count FROM vault_notes WHERE folder <> '' ${options.includeStubs ? '' : 'AND is_stub = 0'} GROUP BY folder`,
    ).all());
    const counts = new Map<string, number>();
    for (const row of rows) {
      const parts = row.folder.split('/');
      for (let depth = 1; depth <= parts.length; depth += 1) {
        const path = parts.slice(0, depth).join('/');
        counts.set(path, (counts.get(path) ?? 0) + row.count);
      }
    }
    return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([path, count]) => {
      const parts = path.split('/');
      return { path, name: parts.at(-1) ?? path, depth: parts.length - 1, count };
    });
  }

  folderNotes(folder: string, options: { readonly includeStubs: boolean; readonly limit: number }): VaultNoteSummary[] {
    const rows = SummaryRowsSchema.parse(this.database.prepare(
      `SELECT id, title, folder, kind, is_stub, updated_at_utc FROM vault_notes WHERE folder = ? ${options.includeStubs ? '' : 'AND is_stub = 0'}`,
    ).all(folder)).map(toSummary);
    if (rows.every((row) => DATED_KINDS.has(row.kind))) {
      return rows.sort((left, right) => right.title.localeCompare(left.title)).slice(0, options.limit);
    }
    const adjacency = loadAdjacency(this.database);
    return rows.sort((left, right) => degreeOf(adjacency, right.id) - degreeOf(adjacency, left.id) || left.title.localeCompare(right.title))
      .slice(0, options.limit);
  }

  backlinks(noteId: string): VaultBacklink[] {
    requireVaultNote(this.database, noteId);
    return this.backlinksOf(noteId);
  }

  outgoing(noteId: string): VaultOutgoing {
    requireVaultNote(this.database, noteId);
    return this.outgoingOf(noteId);
  }

  detail(noteId: string): VaultNoteDetail {
    return { note: requireVaultNote(this.database, noteId), backlinks: this.backlinksOf(noteId), outgoing: this.outgoingOf(noteId) };
  }

  allNotes(): VaultNote[] {
    return readVaultNotes(this.database, 'SELECT * FROM vault_notes ORDER BY folder, title_key');
  }

  review(limit: number): VaultReview {
    const rows = readVaultNotes(
      this.database, 'SELECT n.* FROM vault_notes n JOIN vault_tags t ON t.note_id = n.id AND t.tag = ? ORDER BY n.title_key', UNVERIFIED_TAG_NAME,
    );
    const items = rows.flatMap((note) => parseNoteBody(note.body).unverified.map((fact) => ({
      note: toVaultNoteSummary(note), line: fact.line, label: fact.label, value: fact.value, flag: fact.flag,
    })));
    return { total: items.length, items: items.slice(0, limit) };
  }

  stats(): VaultStats {
    const count = (sql: string, ...params: readonly string[]) => CountSchema.parse(this.database.prepare(sql).get(...params)).count;
    const byKind: VaultStats['byKind'] = { entity: 0, capture: 0, daily: 0, chat: 0, note: 0 };
    for (const row of z.array(z.object({ kind: VaultNoteKindSchema, count: z.number() })).parse(
      this.database.prepare('SELECT kind, COUNT(*) AS count FROM vault_notes GROUP BY kind').all(),
    )) byKind[row.kind] = row.count;
    return {
      notes: count('SELECT COUNT(*) AS count FROM vault_notes'),
      links: count('SELECT COUNT(*) AS count FROM vault_links'),
      tags: count('SELECT COUNT(DISTINCT tag) AS count FROM vault_tags'),
      stubs: count('SELECT COUNT(*) AS count FROM vault_notes WHERE is_stub = 1'),
      notesWithUnverified: count('SELECT COUNT(*) AS count FROM vault_tags WHERE tag = ?', UNVERIFIED_TAG_NAME),
      byKind,
    };
  }

  private backlinksOf(noteId: string): VaultBacklink[] {
    const rows = z.array(z.object({ from_note_id: z.string(), row_label: z.string().nullable() })).parse(this.database.prepare(`
      SELECT l.from_note_id, l.row_label FROM vault_links l
      JOIN vault_key_owners k ON k.key = l.target_key
      WHERE k.note_id = ? AND l.from_note_id <> ? ORDER BY l.line
    `).all(noteId, noteId));
    const labels = new Map<string, Set<string>>();
    for (const row of rows) {
      const set = labels.get(row.from_note_id) ?? new Set<string>();
      if (row.row_label !== null) set.add(row.row_label);
      labels.set(row.from_note_id, set);
    }
    return [...labels.entries()].map(([fromId, set]) => ({ note: toVaultNoteSummary(requireVaultNote(this.database, fromId)), labels: [...set] }))
      .sort((left, right) => right.labels.length - left.labels.length || left.note.title.localeCompare(right.note.title));
  }

  private outgoingOf(noteId: string): VaultOutgoing {
    const targets = z.array(z.object({ target_key: z.string(), note_id: z.string().nullable() })).parse(this.database.prepare(`
      SELECT l.target_key, k.note_id FROM vault_links l
      LEFT JOIN vault_key_owners k ON k.key = l.target_key
      WHERE l.from_note_id = ? GROUP BY l.target_key ORDER BY MIN(l.line)
    `).all(noteId));
    const resolved = new Map<string, VaultNoteSummary>();
    const unresolved: string[] = [];
    for (const target of targets) {
      if (target.note_id === null) unresolved.push(target.target_key);
      else if (target.note_id !== noteId && !resolved.has(target.note_id)) {
        resolved.set(target.note_id, toVaultNoteSummary(requireVaultNote(this.database, target.note_id)));
      }
    }
    return { resolved: [...resolved.values()], unresolved };
  }
}
