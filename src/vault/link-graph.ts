import type { RuntimeDatabase } from '../state/runtime-db.ts';
import { z } from '../lib/zod.ts';

const EdgeRowsSchema = z.array(z.object({ from_note_id: z.string(), note_id: z.string() }));

/** Undirected note-to-note adjacency over resolved links. */
export type VaultAdjacency = ReadonlyMap<string, ReadonlySet<string>>;

export function loadAdjacency(database: RuntimeDatabase): VaultAdjacency {
  const neighbors = new Map<string, Set<string>>();
  const connect = (left: string, right: string) => {
    const set = neighbors.get(left) ?? new Set<string>();
    set.add(right);
    neighbors.set(left, set);
  };
  for (const edge of EdgeRowsSchema.parse(database.prepare(`
    SELECT DISTINCT l.from_note_id, k.note_id FROM vault_links l
    JOIN vault_key_owners k ON k.key = l.target_key
    WHERE k.note_id <> l.from_note_id
  `).all())) {
    connect(edge.from_note_id, edge.note_id);
    connect(edge.note_id, edge.from_note_id);
  }
  return neighbors;
}

export const degreeOf = (adjacency: VaultAdjacency, noteId: string): number => adjacency.get(noteId)?.size ?? 0;
