import type { VaultGraph, VaultGraphNode, VaultLocalGraphDepth } from '@siftkit/contracts';

import type { RuntimeDatabase } from '../state/runtime-db.ts';
import { z } from '../lib/zod.ts';
import { degreeOf, loadAdjacency, type VaultAdjacency } from './link-graph.ts';
import { VaultNoteRowSchema, requireVaultNote } from './note-rows.ts';

const GraphRowsSchema = z.array(VaultNoteRowSchema.pick({ id: true, title: true, folder: true, kind: true }));

export class VaultGraphQueries {
  private readonly database: RuntimeDatabase;

  constructor(database: RuntimeDatabase) {
    this.database = database;
  }

  global(options: { readonly minLinks: number; readonly hiddenTopFolders: readonly string[] }): VaultGraph {
    const adjacency = loadAdjacency(this.database);
    const hidden = new Set(options.hiddenTopFolders);
    const nodes = this.allNodes(adjacency).filter((node) => !hidden.has(node.topFolder) && node.degree >= options.minLinks);
    return { nodes, edges: edgesAmong(nodes, adjacency) };
  }

  local(noteId: string, depth: VaultLocalGraphDepth, cap: number): VaultGraph {
    requireVaultNote(this.database, noteId);
    const adjacency = loadAdjacency(this.database);
    const included = new Set([noteId]);
    let frontier = [noteId];
    for (let hop = 0; hop < depth; hop += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const neighbor of [...(adjacency.get(id) ?? [])].sort()) {
          if (included.size >= cap) break;
          if (!included.has(neighbor)) {
            included.add(neighbor);
            next.push(neighbor);
          }
        }
      }
      frontier = next;
    }
    const nodes = this.allNodes(adjacency).filter((node) => included.has(node.id));
    return { nodes, edges: edgesAmong(nodes, adjacency) };
  }

  private allNodes(adjacency: VaultAdjacency): VaultGraphNode[] {
    return GraphRowsSchema.parse(this.database.prepare('SELECT id, title, folder, kind FROM vault_notes ORDER BY title_key').all())
      .map((row) => ({ id: row.id, title: row.title, folder: row.folder, topFolder: row.folder.split('/')[0] ?? '', kind: row.kind, degree: degreeOf(adjacency, row.id) }));
  }
}

function edgesAmong(nodes: readonly VaultGraphNode[], adjacency: VaultAdjacency): VaultGraph['edges'] {
  const ids = new Set(nodes.map((node) => node.id));
  const edges: VaultGraph['edges'] = [];
  for (const node of nodes) {
    for (const neighbor of adjacency.get(node.id) ?? []) {
      if (ids.has(neighbor) && node.id < neighbor) edges.push({ source: node.id, target: neighbor });
    }
  }
  return edges;
}
