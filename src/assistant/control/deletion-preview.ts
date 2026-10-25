import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from '../../lib/zod.ts';
import { parseJsonText } from '../../lib/json.ts';
import type { AssistantFactoryResetPreview } from '@siftkit/contracts';
import type { AssistantGraph } from '../assistant-graph.ts';
import type { RuntimeDatabase } from '../../state/runtime-db.ts';
import { AssistantConflictError } from '../errors.ts';
import { ASSISTANT_METADATA_PREFIX } from '../storage/schema.ts';

const PREVIEW_SECRET_KEY = `${ASSISTANT_METADATA_PREFIX}deletion_preview.secret.v1`;

const PreviewPayloadSchema = z.object({
  ownerId: z.string(),
  graphVersion: z.number().int().min(0),
  totalRows: z.number().int().min(0),
}).strict();
type PreviewPayload = z.infer<typeof PreviewPayloadSchema>;

export class DeletionPreviewService {
  private readonly graph: AssistantGraph;
  private readonly database: RuntimeDatabase;

  constructor(
    graph: AssistantGraph,
    database: RuntimeDatabase,
  ) {
    this.graph = graph;
    this.database = database;
  }

  /**
   * Counts come from the caller — `FactoryResetService` owns the table inventory. The signed
   * payload records what the user was shown; staleness is decided by the graph version alone,
   * because background rows (jobs, retrieval usage) churn without any graph mutation.
   */
  previewFactoryReset(
    ownerId: string,
    tableCounts: Readonly<Record<string, number>>,
    blobs: { readonly blobCount: number; readonly blobBytes: number },
  ): AssistantFactoryResetPreview {
    const totalRows = Object.values(tableCounts).reduce((sum, count) => sum + count, 0);
    return {
      previewToken: this.sign({
        ownerId,
        graphVersion: this.graph.graphVersion,
        totalRows,
      }),
      graphVersion: this.graph.graphVersion,
      tableCounts: { ...tableCounts },
      blobCount: blobs.blobCount,
      blobBytes: blobs.blobBytes,
    };
  }

  validateFactoryReset(ownerId: string, previewToken: string): void {
    const payload = this.verify(previewToken);
    if (payload.ownerId !== ownerId) {
      throw new AssistantConflictError('Deletion preview token does not authorize a factory reset.');
    }
    if (payload.graphVersion !== this.graph.graphVersion) {
      throw new AssistantConflictError('Deletion preview is stale because the graph version changed.');
    }
  }

  private sign(payload: PreviewPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${encoded}.${this.signature(encoded)}`;
  }

  private verify(token: string): PreviewPayload {
    const parts = token.split('.');
    const encoded = parts.length === 2 ? parts[0] : undefined;
    const suppliedSignature = parts.length === 2 ? parts[1] : undefined;
    if (encoded === undefined || suppliedSignature === undefined) {
      throw new Error('Invalid deletion preview token.');
    }
    const expectedSignature = this.signature(encoded);
    const suppliedBytes = Buffer.from(suppliedSignature, 'base64url');
    const expectedBytes = Buffer.from(expectedSignature, 'base64url');
    if (
      suppliedBytes.length !== expectedBytes.length
      || suppliedBytes.toString('base64url') !== suppliedSignature
      || !timingSafeEqual(suppliedBytes, expectedBytes)
    ) {
      throw new Error('Invalid deletion preview token signature.');
    }
    try {
      return parseJsonText(Buffer.from(encoded, 'base64url').toString('utf8'), PreviewPayloadSchema);
    } catch {
      throw new Error('Invalid deletion preview token payload.');
    }
  }

  private signature(encodedPayload: string): string {
    return createHmac('sha256', this.secret()).update(encodedPayload).digest('base64url');
  }

  private secret(): Buffer {
    const existing = this.database.prepare(
      'SELECT value FROM runtime_metadata WHERE key = ?',
    ).get(PREVIEW_SECRET_KEY);
    if (existing !== undefined && existing !== null) {
      return Buffer.from(z.object({ value: z.string() }).parse(existing).value, 'base64url');
    }
    const secret = randomBytes(32);
    this.database.prepare(`
      INSERT INTO runtime_metadata (key, value, updated_at_utc) VALUES (?, ?, ?)
    `).run(PREVIEW_SECRET_KEY, secret.toString('base64url'), this.graph.nowUtc());
    return secret;
  }
}
