import { parseNoteBody, sectionLines, type VaultNote } from '@siftkit/contracts';

import type { Clock } from '../../../assistant/clock.ts';
import { QueryIntentExtractor } from '../../../assistant/retrieval/query-intent.ts';
import { toError } from '../../../lib/errors.ts';
import type { JsonObject } from '../../../lib/json-types.ts';
import { z } from '../../../lib/zod.ts';
import type { RuntimeDatabase } from '../../../state/database-handle.ts';
import { FactPointRowSchema, factAges, factPointKey, touchAccess } from '../../fact-points.ts';
import { readVaultNote } from '../../note-rows.ts';
import type { VaultNoteStore } from '../../note-store.ts';
import { searchNoteIds } from '../../vault-fts.ts';
import { LEARNED_HEADING, captureFolder } from '../../vault-layout.ts';

/** About 1,500 tokens per tool result. */
export const MAX_RESULT_CHARS = 6_000;
export const READ_PAGE_VALUES = 40;
const MAX_BACKLINKS = 10;
const CLOSEST_LIMIT = 3;
const UNLABELLED_RELATION = 'mentions';

export const SearchNotesArgsSchema = z.object({ query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(10).default(5) }).strict();
export const ReadNoteArgsSchema = z.object({ title: z.string().trim().min(1).max(120), page: z.number().int().min(1).default(1) }).strict();
export const NeighborsArgsSchema = z.object({ title: z.string().trim().min(1).max(120), depth: z.union([z.literal(1), z.literal(2)]).default(1) }).strict();
export const DayContextArgsSchema = z.object({}).strict();

const OutgoingRowsSchema = z.array(z.object({ label: z.string(), other_id: z.string().nullable(), target_key: z.string() }));
const IncomingRowsSchema = z.array(z.object({ label: z.string().nullable(), other_id: z.string() }));
const CaptureRowsSchema = z.array(z.object({ app: z.string(), window_title: z.string().nullable(), note_id: z.string() }));
const NoteIdRowsSchema = z.array(z.object({ note_id: z.string() }));

interface Relation {
  readonly text: string;
  readonly otherId: string | null;
}

export interface VaultWriterToolsOptions {
  readonly database: RuntimeDatabase;
  readonly store: VaultNoteStore;
  readonly clock: Clock;
  /** The local day `day_context` reports: the source's day. */
  readonly day: string;
}

const cap = (text: string) => (text.length <= MAX_RESULT_CHARS ? text : `${text.slice(0, MAX_RESULT_CHARS)}\n… (truncated)`);
const typesOf = (note: VaultNote) => note.types.join(', ') || 'untyped';

/** The agent's read-only view of the vault. Tools never write content; they only stamp access. */
export class VaultWriterTools {
  private readonly options: VaultWriterToolsOptions;

  constructor(options: VaultWriterToolsOptions) {
    this.options = options;
  }

  /** Runs one tool; any failure becomes a result the model can correct from. */
  execute(name: string, args: JsonObject): string {
    try {
      switch (name) {
        case 'search_notes': return cap(this.search(SearchNotesArgsSchema.parse(args)));
        case 'read_note': return cap(this.readNote(ReadNoteArgsSchema.parse(args)));
        case 'neighbors': return cap(this.neighbors(NeighborsArgsSchema.parse(args)));
        case 'day_context': DayContextArgsSchema.parse(args); return cap(this.dayContext());
        default: return `Error: unknown tool "${name}".`;
      }
    } catch (error) {
      return `Error: ${toError(error).message}`;
    }
  }

  private matches(text: string, limit: number): VaultNote[] {
    return searchNoteIds(this.options.database, new QueryIntentExtractor().extract(text).terms, ['entity'], limit)
      .flatMap((id) => readVaultNote(this.options.database, id) ?? []);
  }

  private search(args: z.infer<typeof SearchNotesArgsSchema>): string {
    const notes = this.matches(args.query, args.limit);
    if (notes.length === 0) return `no notes match "${args.query}"`;
    const terms = new QueryIntentExtractor().extract(args.query).terms.map((term) => term.toLowerCase());
    return notes.map((note) => {
      const snippet = note.body.split('\n').find((line) => terms.some((term) => line.toLowerCase().includes(term)));
      return [
        `- ${note.title} · ${note.folder || 'no folder'} · ${typesOf(note)}`,
        ...(note.aliases.length === 0 ? [] : [`  aliases: ${note.aliases.join(', ')}`]),
        ...(snippet === undefined ? [] : [`  > ${snippet.trim()}`]),
      ].join('\n');
    }).join('\n');
  }

  private readNote(args: z.infer<typeof ReadNoteArgsSchema>): string {
    const note = this.options.store.resolve(args.title);
    if (note === null) {
      const closest = this.matches(args.title, CLOSEST_LIMIT).map((candidate) => candidate.title);
      return `no note "${args.title}"; closest: ${closest.length === 0 ? 'none' : closest.join(', ')}`;
    }
    const { database, clock } = this.options;
    const nowUtc = clock.nowUtc();
    const parsed = parseNoteBody(note.body);
    const ages = new Map(z.array(FactPointRowSchema).parse(database.prepare('SELECT * FROM vault_fact_points WHERE note_id = ?').all(note.id))
      .map((row) => [`${row.label_key}\n${row.value_key}`, row]));
    const values = parsed.factRows.flatMap((row) => row.values.map((value) => ({ label: row.label, value, key: factPointKey(row.label, value) })));
    const start = (args.page - 1) * READ_PAGE_VALUES;
    const page = values.slice(start, start + READ_PAGE_VALUES);
    const end = start + page.length;
    touchAccess(database, note.id, page.map((entry) => entry.key), nowUtc);
    const valueLines = page.map(({ label, value, key }) => {
      const row = ages.get(`${key.labelKey}\n${key.valueKey}`);
      return `- **${label}** ${value}${row === undefined ? '' : ` — ${factAges(row, nowUtc)}`}`;
    });
    const unverified = parsed.unverified.map((fact) => {
      const flag = fact.flag === null ? '' : fact.flag.kind === 'replaces' ? ` (replaces: ${fact.flag.value})` : ` (doubt: ${fact.flag.reason})`;
      return `- **${fact.label ?? 'Facts'}** ${fact.value}${flag}`;
    });
    const tasks = parsed.tasks.filter((task) => !task.done).map((task) => `- ${task.text}`);
    const backlinks = this.incoming(note).slice(0, MAX_BACKLINKS).map((relation) => `- ${relation.text}`);
    return [
      `# ${note.title}  (${note.folder || 'no folder'} · ${typesOf(note)})`,
      `aliases: ${note.aliases.join(', ') || 'none'}`,
      `lead: ${parsed.lead?.text ?? 'none'}`,
      'facts:', ...(valueLines.length === 0 ? [values.length === 0 ? '- none' : `- no values on page ${args.page}`] : valueLines),
      'open tasks:', ...(tasks.length === 0 ? ['- none'] : tasks),
      'unverified:', ...(unverified.length === 0 ? ['- none'] : unverified),
      'backlinks:', ...(backlinks.length === 0 ? ['- none'] : backlinks),
      ...(values.length > end ? [`values ${start + 1}–${end} of ${values.length} · next page ${args.page + 1}`] : []),
    ].join('\n');
  }

  /** Fact rows of `note` linking out, as `Note —Label→ Target`. */
  private outgoing(note: VaultNote): Relation[] {
    return OutgoingRowsSchema.parse(this.options.database.prepare(`
      SELECT l.row_label AS label, k.note_id AS other_id, l.target_key FROM vault_links l
      LEFT JOIN vault_key_owners k ON k.key = l.target_key
      WHERE l.from_note_id = ? AND l.row_label IS NOT NULL ORDER BY l.line
    `).all(note.id)).map((row) => ({
      text: `${note.title} —${row.label}→ ${row.other_id === null ? row.target_key : readVaultNote(this.options.database, row.other_id)?.title ?? row.target_key}`,
      otherId: row.other_id,
    }));
  }

  /** Entity notes linking to `note`, labelled by their fact row or as a mention. */
  private incoming(note: VaultNote): Relation[] {
    return IncomingRowsSchema.parse(this.options.database.prepare(`
      SELECT l.row_label AS label, l.from_note_id AS other_id FROM vault_links l
      JOIN vault_key_owners k ON k.key = l.target_key JOIN vault_notes n ON n.id = l.from_note_id
      WHERE k.note_id = ? AND l.from_note_id <> ? AND n.kind = 'entity' ORDER BY l.line
    `).all(note.id, note.id)).flatMap((row) => {
      const source = readVaultNote(this.options.database, row.other_id);
      return source === null ? [] : [{ text: `${source.title} —${row.label ?? UNLABELLED_RELATION}→ ${note.title}`, otherId: source.id }];
    });
  }

  private neighbors(args: z.infer<typeof NeighborsArgsSchema>): string {
    const root = this.options.store.resolve(args.title);
    if (root === null) return `no note "${args.title}"`;
    const lines = new Set<string>();
    const listed = new Set<string>([root.id]);
    let frontier: VaultNote[] = [root];
    for (let level = 0; level < args.depth; level += 1) {
      const next: VaultNote[] = [];
      for (const note of frontier) {
        for (const relation of [...this.outgoing(note), ...this.incoming(note)]) {
          lines.add(`- ${relation.text}`);
          if (relation.otherId === null || listed.has(relation.otherId)) continue;
          listed.add(relation.otherId);
          const other = readVaultNote(this.options.database, relation.otherId);
          if (other !== null) next.push(other);
        }
      }
      frontier = next;
    }
    const nowUtc = this.options.clock.nowUtc();
    for (const id of listed) touchAccess(this.options.database, id, [], nowUtc);
    return lines.size === 0 ? `${root.title} has no relations` : [...lines].join('\n');
  }

  private dayContext(): string {
    const { database, day } = this.options;
    const learnedOf = (id: string) => (sectionLines(readVaultNote(database, id)?.body ?? '', LEARNED_HEADING) ?? [])
      .filter((line) => line.trim().length > 0).map((line) => `  ${line}`);
    const captures = CaptureRowsSchema.parse(database.prepare(`
      SELECT c.app, c.window_title, c.note_id FROM vault_captures c JOIN vault_notes n ON n.id = c.note_id
      WHERE n.folder = ? AND c.processed_at_utc IS NOT NULL ORDER BY c.captured_at_utc
    `).all(captureFolder(day)));
    const chats = NoteIdRowsSchema.parse(database.prepare('SELECT note_id FROM vault_chat_notes WHERE day = ?').all(day));
    return [
      `Captures on ${day}:`,
      ...(captures.length === 0 ? ['- none'] : captures.flatMap((capture) => [
        `- ${capture.app}${capture.window_title === null ? '' : ` · ${capture.window_title}`}`, ...learnedOf(capture.note_id)])),
      `Chats on ${day}:`,
      ...(chats.length === 0 ? ['- none'] : chats.flatMap((chat) => [`- ${readVaultNote(database, chat.note_id)?.title ?? chat.note_id}`, ...learnedOf(chat.note_id)])),
    ].join('\n');
  }
}
