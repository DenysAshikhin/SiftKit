import { z } from '../../lib/zod.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';

/** SQLite's default parameter cap is 999; stay far under it per chunk. */
const ID_CHUNK = 400;

/** Deduplicated ids split into 400-id chunks, preserving first-seen order. */
export function chunkIds(ids: readonly string[]): string[][] {
  const unique = [...new Set(ids)];
  const chunks: string[][] = [];
  for (let start = 0; start < unique.length; start += ID_CHUNK) {
    chunks.push(unique.slice(start, start + ID_CHUNK));
  }
  return chunks;
}

/** Batch fetch by id, deduplicated. Missing ids are simply absent from the result. */
export function fetchRowsByIds<Row extends { id: string }>(
  database: RuntimeDatabase,
  table: 'graph_nodes' | 'graph_assertions' | 'memory_projections' | 'evidence_records',
  schema: z.ZodType<Row>,
  ids: readonly string[],
): Map<string, Row> {
  const found = new Map<string, Row>();
  for (const chunk of chunkIds(ids)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = z.array(schema).parse(database.prepare(
      `SELECT * FROM ${table} WHERE id IN (${placeholders})`,
    ).all(...chunk));
    for (const row of rows) found.set(row.id, row);
  }
  return found;
}

/** The three canonical tables that mirror an fts5 index via a `fts_rowid` column. */
const FTS_TABLES = {
  graph_nodes: 'graph_nodes_fts',
  graph_assertions: 'graph_assertions_fts',
  memory_projections: 'memory_projections_fts',
} as const;
export type FtsIndexedTable = keyof typeof FTS_TABLES;

/**
 * Deletes a row's FTS entry by the recorded rowid (indexed) — never by the UNINDEXED id column,
 * which would scan the whole FTS table — and clears the tracking column. No-op when the row was
 * never indexed.
 */
export function dropFtsRow(
  database: RuntimeDatabase,
  table: FtsIndexedTable,
  rowId: string,
  ftsRowid: number | null,
): void {
  if (ftsRowid === null) return;
  database.prepare(`DELETE FROM ${FTS_TABLES[table]} WHERE rowid = ?`).run(ftsRowid);
  database.prepare(`UPDATE ${table} SET fts_rowid = NULL WHERE id = ?`).run(rowId);
}

/** Records a freshly inserted FTS rowid on the canonical row so the next drop is indexed. */
export function recordFtsRowid(
  database: RuntimeDatabase,
  table: FtsIndexedTable,
  rowId: string,
  ftsRowid: number | bigint,
): void {
  database.prepare(`UPDATE ${table} SET fts_rowid = ? WHERE id = ?`).run(ftsRowid, rowId);
}
