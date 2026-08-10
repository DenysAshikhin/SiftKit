import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from '../../lib/zod.js';
import { parseJsonText } from '../../lib/json.js';
import type { AssistantDeletionPreview } from '@siftkit/contracts';
import type { AssistantGraph } from '../assistant-graph.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';

const PREVIEW_SECRET_KEY = 'assistant.deletion_preview.secret.v1';

const PreviewPayloadSchema = z.object({
  ownerId: z.string(),
  operation: z.literal('forget_assertion'),
  targetAssertionId: z.string(),
  graphVersion: z.number().int().min(0),
  affectedProjectionIds: z.array(z.string()),
  dependentAssertionIds: z.array(z.string()),
}).strict();
type PreviewPayload = z.infer<typeof PreviewPayloadSchema>;

export class DeletionPreviewService {
  constructor(
    private readonly graph: AssistantGraph,
    private readonly database: RuntimeDatabase,
  ) {}

  previewForgetAssertion(ownerId: string, assertionId: string): AssistantDeletionPreview {
    const payload = this.buildPayload(ownerId, assertionId);
    return {
      previewToken: this.sign(payload),
      graphVersion: payload.graphVersion,
      targetAssertionId: payload.targetAssertionId,
      affectedProjectionIds: payload.affectedProjectionIds,
      dependentAssertionIds: payload.dependentAssertionIds,
    };
  }

  validateForgetAssertion(ownerId: string, assertionId: string, previewToken: string): void {
    const payload = this.verify(previewToken);
    if (payload.ownerId !== ownerId || payload.targetAssertionId !== assertionId) {
      throw new Error('Deletion preview token does not match this assertion.');
    }
    if (payload.graphVersion !== this.graph.graphVersion) {
      throw new Error('Deletion preview is stale because the graph version changed.');
    }
    const current = this.buildPayload(ownerId, assertionId);
    if (JSON.stringify(current) !== JSON.stringify(payload)) {
      throw new Error('Deletion preview is stale because its affected rows changed.');
    }
  }

  private buildPayload(ownerId: string, assertionId: string): PreviewPayload {
    const assertion = this.graph.assertions.getAssertion(assertionId);
    if (assertion === null || assertion.owner_id !== ownerId) {
      throw new Error(`Unknown assertion for owner: ${assertionId}`);
    }
    const affectedProjectionIds = this.graph.projections.listAll(ownerId)
      .filter((projection) => this.graph.projections.readIncludedAssertionIds(projection).includes(assertionId))
      .map((projection) => projection.id)
      .sort();
    const dependentAssertionIds = this.graph.assertions.listDependents(assertionId)
      .map((dependent) => dependent.id)
      .sort();
    return {
      ownerId,
      operation: 'forget_assertion',
      targetAssertionId: assertionId,
      graphVersion: this.graph.graphVersion,
      affectedProjectionIds,
      dependentAssertionIds,
    };
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
