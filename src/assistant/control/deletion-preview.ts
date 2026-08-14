import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from '../../lib/zod.js';
import { parseJsonText } from '../../lib/json.js';
import type {
  AssistantDeletionPreview,
  AssistantEvidenceDeletionPreview,
  AssistantFactoryResetPreview,
  AssistantTopicForgetPreview,
} from '@siftkit/contracts';
import type { AssistantGraph } from '../assistant-graph.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import { AssistantConflictError, AssistantNotFoundError } from '../errors.js';
import { AssertionViewBuilder } from '../projections/assertion-view-builder.js';
import { LIVE_ASSERTION_STATUSES } from '../storage/assertion-store.js';
import { ASSISTANT_METADATA_PREFIX, OWNER_PERSON_CANONICAL_KEY } from '../storage/schema.js';

const PREVIEW_SECRET_KEY = `${ASSISTANT_METADATA_PREFIX}deletion_preview.secret.v1`;

const ForgetAssertionPayloadSchema = z.object({
  ownerId: z.string(),
  operation: z.literal('forget_assertion'),
  targetAssertionId: z.string(),
  graphVersion: z.number().int().min(0),
  affectedProjectionIds: z.array(z.string()),
  dependentAssertionIds: z.array(z.string()),
}).strict();

const DeleteEvidencePayloadSchema = z.object({
  ownerId: z.string(),
  operation: z.literal('delete_evidence'),
  targetEvidenceId: z.string(),
  graphVersion: z.number().int().min(0),
  dependentAssertionIds: z.array(z.string()),
  affectedProjectionIds: z.array(z.string()),
}).strict();

const ForgetTopicPayloadSchema = z.object({
  ownerId: z.string(),
  operation: z.literal('forget_topic'),
  topicKey: z.string(),
  graphVersion: z.number().int().min(0),
  assertionIds: z.array(z.string()),
  affectedProjectionIds: z.array(z.string()),
}).strict();

const FactoryResetPayloadSchema = z.object({
  ownerId: z.string(),
  operation: z.literal('factory_reset'),
  graphVersion: z.number().int().min(0),
  totalRows: z.number().int().min(0),
}).strict();

const PreviewPayloadSchema = z.discriminatedUnion('operation', [
  ForgetAssertionPayloadSchema,
  DeleteEvidencePayloadSchema,
  ForgetTopicPayloadSchema,
  FactoryResetPayloadSchema,
]);
type PreviewPayload = z.infer<typeof PreviewPayloadSchema>;
type ForgetAssertionPayload = z.infer<typeof ForgetAssertionPayloadSchema>;
type DeleteEvidencePayload = z.infer<typeof DeleteEvidencePayloadSchema>;
type ForgetTopicPayload = z.infer<typeof ForgetTopicPayloadSchema>;

/**
 * Every live owner assertion whose derived topic key matches. One implementation, shared by the
 * forget-topic preview and its confirm, so the two can never disagree about scope.
 */
export function topicAssertionIds(
  graph: AssistantGraph,
  ownerId: string,
  topicKey: string,
): string[] {
  const owner = graph.nodes.findByCanonicalKey(ownerId, 'person', OWNER_PERSON_CANONICAL_KEY);
  if (owner === null) return [];
  const views = new AssertionViewBuilder(graph);
  const rows = graph.assertions.listBySubject(ownerId, owner.id, LIVE_ASSERTION_STATUSES);
  return views.buildMany(rows)
    .filter((view) => view.topicKey === topicKey)
    .map((view) => view.assertionId)
    .sort();
}

export class DeletionPreviewService {
  constructor(
    private readonly graph: AssistantGraph,
    private readonly database: RuntimeDatabase,
  ) {}

  previewForgetAssertion(ownerId: string, assertionId: string): AssistantDeletionPreview {
    const payload = this.buildForgetAssertionPayload(ownerId, assertionId);
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
    if (
      payload.operation !== 'forget_assertion'
      || payload.ownerId !== ownerId
      || payload.targetAssertionId !== assertionId
    ) {
      throw new AssistantConflictError('Deletion preview token does not match this assertion.');
    }
    this.assertCurrent(payload, this.buildForgetAssertionPayload(ownerId, assertionId));
  }

  previewDeleteEvidence(ownerId: string, evidenceId: string): AssistantEvidenceDeletionPreview {
    const payload = this.buildDeleteEvidencePayload(ownerId, evidenceId);
    return {
      previewToken: this.sign(payload),
      graphVersion: payload.graphVersion,
      targetEvidenceId: payload.targetEvidenceId,
      dependentAssertionIds: payload.dependentAssertionIds,
      affectedProjectionIds: payload.affectedProjectionIds,
    };
  }

  validateDeleteEvidence(ownerId: string, evidenceId: string, previewToken: string): void {
    const payload = this.verify(previewToken);
    if (
      payload.operation !== 'delete_evidence'
      || payload.ownerId !== ownerId
      || payload.targetEvidenceId !== evidenceId
    ) {
      throw new AssistantConflictError('Deletion preview token does not match this evidence.');
    }
    this.assertCurrent(payload, this.buildDeleteEvidencePayload(ownerId, evidenceId));
  }

  previewForgetTopic(ownerId: string, topicKey: string): AssistantTopicForgetPreview {
    const payload = this.buildForgetTopicPayload(ownerId, topicKey);
    return {
      previewToken: this.sign(payload),
      graphVersion: payload.graphVersion,
      topicKey: payload.topicKey,
      assertionIds: payload.assertionIds,
      affectedProjectionIds: payload.affectedProjectionIds,
    };
  }

  validateForgetTopic(ownerId: string, topicKey: string, previewToken: string): void {
    const payload = this.verify(previewToken);
    if (
      payload.operation !== 'forget_topic'
      || payload.ownerId !== ownerId
      || payload.topicKey !== topicKey
    ) {
      throw new AssistantConflictError('Deletion preview token does not match this topic.');
    }
    this.assertCurrent(payload, this.buildForgetTopicPayload(ownerId, topicKey));
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
        operation: 'factory_reset',
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
    if (payload.operation !== 'factory_reset' || payload.ownerId !== ownerId) {
      throw new AssistantConflictError('Deletion preview token does not authorize a factory reset.');
    }
    if (payload.graphVersion !== this.graph.graphVersion) {
      throw new AssistantConflictError('Deletion preview is stale because the graph version changed.');
    }
  }

  /** The token is only as good as the state it described: rebuild and compare, never trust. */
  private assertCurrent(payload: PreviewPayload, current: PreviewPayload): void {
    if (payload.graphVersion !== this.graph.graphVersion) {
      throw new AssistantConflictError('Deletion preview is stale because the graph version changed.');
    }
    if (JSON.stringify(current) !== JSON.stringify(payload)) {
      throw new AssistantConflictError('Deletion preview is stale because its affected rows changed.');
    }
  }

  private buildForgetAssertionPayload(
    ownerId: string,
    assertionId: string,
  ): ForgetAssertionPayload {
    const assertion = this.graph.assertions.getAssertion(assertionId);
    if (assertion === null || assertion.owner_id !== ownerId) {
      throw new AssistantNotFoundError(`Unknown assertion for owner: ${assertionId}`);
    }
    const dependentAssertionIds = this.graph.assertions.listDependents(assertionId)
      .map((dependent) => dependent.id)
      .sort();
    return {
      ownerId,
      operation: 'forget_assertion',
      targetAssertionId: assertionId,
      graphVersion: this.graph.graphVersion,
      affectedProjectionIds: this.projectionsCiting(ownerId, [assertionId]),
      dependentAssertionIds,
    };
  }

  private buildDeleteEvidencePayload(
    ownerId: string,
    evidenceId: string,
  ): DeleteEvidencePayload {
    const evidence = this.graph.evidence.getEvidence(evidenceId);
    if (evidence === null || evidence.owner_id !== ownerId || evidence.status !== 'active') {
      throw new AssistantNotFoundError(`Unknown active evidence for owner: ${evidenceId}`);
    }
    const dependentAssertionIds = [
      ...this.graph.assertions.listAssertionIdsForEvidence(evidenceId),
    ].sort();
    return {
      ownerId,
      operation: 'delete_evidence',
      targetEvidenceId: evidenceId,
      graphVersion: this.graph.graphVersion,
      dependentAssertionIds,
      affectedProjectionIds: this.projectionsCiting(ownerId, dependentAssertionIds),
    };
  }

  private buildForgetTopicPayload(ownerId: string, topicKey: string): ForgetTopicPayload {
    const assertionIds = topicAssertionIds(this.graph, ownerId, topicKey);
    const cited = new Set(assertionIds);
    const affectedProjectionIds = this.graph.projections.listAll(ownerId)
      .filter((projection) => projection.topic_key === topicKey
        || this.graph.projections.readIncludedAssertionIds(projection)
          .some((assertionId) => cited.has(assertionId)))
      .map((projection) => projection.id)
      .sort();
    return {
      ownerId,
      operation: 'forget_topic',
      topicKey,
      graphVersion: this.graph.graphVersion,
      assertionIds,
      affectedProjectionIds,
    };
  }

  /** Live projections whose included-assertion list intersects `assertionIds`, sorted. */
  private projectionsCiting(ownerId: string, assertionIds: readonly string[]): string[] {
    const wanted = new Set(assertionIds);
    if (wanted.size === 0) return [];
    return this.graph.projections.listAll(ownerId)
      .filter((projection) => this.graph.projections.readIncludedAssertionIds(projection)
        .some((assertionId) => wanted.has(assertionId)))
      .map((projection) => projection.id)
      .sort();
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
