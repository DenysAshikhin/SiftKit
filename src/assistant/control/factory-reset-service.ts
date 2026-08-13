import fs from 'node:fs';

import type { AssistantFactoryResetPreview } from '@siftkit/contracts';
import { z } from '../../lib/zod.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import type { AssistantGraph } from '../assistant-graph.js';
import type { Clock } from '../clock.js';
import type { KeyCustodyService } from '../crypto/key-custody.js';
import { assistantEvidenceDir } from '../layout.js';
import { CountRowSchema } from '../storage/rows.js';
import {
  ASSISTANT_FTS_TABLE_NAMES, ASSISTANT_TABLE_NAMES, GRAPH_VERSION_METADATA_KEY,
  seedAssistantRegistries,
} from '../storage/schema.js';
import type { DeletionPreviewService } from './deletion-preview.js';

const BlobStatsRowSchema = z.object({ count: z.number(), bytes: z.number() });

export interface FactoryResetServiceOptions {
  readonly graph: AssistantGraph;
  readonly database: RuntimeDatabase;
  readonly clock: Clock;
  readonly keyCustody: KeyCustodyService;
  readonly previews: DeletionPreviewService;
}

/**
 * §16.1 factory reset: every assistant row, every evidence blob, and the evidence key are
 * destroyed, then the registries, owner, and device row are re-seeded so the next enable starts
 * from a clean install rather than a broken one. Nothing outside the assistant is touched —
 * `runtime_metadata` keys belonging to the rest of SiftKit survive.
 */
export class FactoryResetService {
  private readonly graph: AssistantGraph;
  private readonly database: RuntimeDatabase;
  private readonly clock: Clock;
  private readonly keyCustody: KeyCustodyService;
  private readonly previews: DeletionPreviewService;

  constructor(options: FactoryResetServiceOptions) {
    this.graph = options.graph;
    this.database = options.database;
    this.clock = options.clock;
    this.keyCustody = options.keyCustody;
    this.previews = options.previews;
  }

  preview(ownerId: string): AssistantFactoryResetPreview {
    return this.previews.previewFactoryReset(ownerId, this.tableCounts(), this.blobStats(ownerId));
  }

  confirm(ownerId: string, previewToken: string): void {
    this.previews.validateFactoryReset(ownerId, previewToken);
    // Read before the delete: the device id lives in `runtime_metadata`, but the row it names
    // does not, and the re-seed has to restore the same identity.
    const localDeviceId = this.graph.identity.getLocalDeviceId();
    const transaction = this.graph.transactions.begin();
    try {
      for (const table of ASSISTANT_FTS_TABLE_NAMES) {
        this.database.prepare(`DELETE FROM ${table}`).run();
      }
      for (const table of ASSISTANT_TABLE_NAMES) {
        this.database.prepare(`DELETE FROM ${table}`).run();
      }
      this.database.prepare(
        'UPDATE runtime_metadata SET value = ?, updated_at_utc = ? WHERE key = ?',
      ).run('0', this.clock.nowUtc(), GRAPH_VERSION_METADATA_KEY);
      seedAssistantRegistries(this.database, this.clock, localDeviceId);
      transaction.commit();
    } catch (error) {
      return transaction.rollbackAfter(error);
    }
    // Only once the database is committed: files cannot be rolled back, and orphaned rows
    // pointing at deleted blobs would be worse than blobs with no rows.
    fs.rmSync(assistantEvidenceDir(this.graph.runtimeRoot), { recursive: true, force: true });
    this.keyCustody.resetForFactoryReset();
  }

  private tableCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const table of ASSISTANT_TABLE_NAMES) {
      counts[table] = CountRowSchema.parse(
        this.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
      ).count;
    }
    return counts;
  }

  private blobStats(ownerId: string): { blobCount: number; blobBytes: number } {
    const parsed = BlobStatsRowSchema.parse(this.database.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(byte_length), 0) AS bytes
      FROM evidence_blobs WHERE owner_id = ? AND deleted_at_utc IS NULL
    `).get(ownerId));
    return { blobCount: parsed.count, blobBytes: parsed.bytes };
  }
}
