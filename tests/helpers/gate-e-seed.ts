import { toTopicKey } from '../../src/assistant/projections/assertion-view-builder.js';
import type { AssertionRow } from '../../src/assistant/storage/rows.js';
import { OWNER_PERSON_CANONICAL_KEY } from '../../src/assistant/storage/schema.js';
import type { AssistantTestContext } from './assistant-fixture.js';

export interface SeededOwnerAssertion {
  readonly assertion: AssertionRow;
  readonly evidenceId: string;
  /** The projection topic the assertion routes to — `toTopicKey(objectName)`. */
  readonly topicKey: string;
}

export interface SeedOwnerAssertionInput {
  readonly objectName: string;
  /** `USES` and `OWNS` are `many`/dossier; `PREFERS` is `core` and lands in the tier 1 profile. */
  readonly predicate?: 'PREFERS' | 'USES' | 'OWNS';
  /**
   * A scope node name. The topic key still comes from `objectName`, so distinct variants stack
   * several coexisting assertions onto one topic — which is what tier routing scores.
   */
  readonly variant?: string;
}

/**
 * One explicit owner assertion whose topic key derives from the object display name
 * (`toTopicKey` slugs it). Distinct object names produce distinct Tier 2/3 topics.
 */
export function seedOwnerAssertion(
  context: AssistantTestContext,
  input: SeedOwnerAssertionInput,
): SeededOwnerAssertion {
  const { graph, ownerId } = context;
  const predicate = input.predicate ?? 'USES';
  const variant = input.variant ?? '';
  const owner = graph.nodes.findByCanonicalKey(ownerId, 'person', OWNER_PERSON_CANONICAL_KEY)
    ?? graph.nodes.createNode({
      ownerId, type: 'person', canonicalKey: OWNER_PERSON_CANONICAL_KEY,
      displayName: 'the user', description: null, sensitivity: 'personal', properties: {},
    });
  const objectKey = `software:${input.objectName}`;
  const object = graph.nodes.findByCanonicalKey(ownerId, 'software', objectKey)
    ?? graph.nodes.createNode({
      ownerId, type: 'software', canonicalKey: objectKey,
      displayName: input.objectName, description: null, sensitivity: 'personal', properties: {},
    });
  const scope = variant === ''
    ? null
    : graph.nodes.findByCanonicalKey(ownerId, 'topic', `topic:${variant}`)
      ?? graph.nodes.createNode({
        ownerId, type: 'topic', canonicalKey: `topic:${variant}`,
        displayName: variant, description: null, sensitivity: 'personal', properties: {},
      });
  const evidence = graph.evidence.recordTextEvidence({
    ownerId, deviceId: null, parentEvidenceId: null, sourceType: 'conversation_message',
    sourceEventId: `gate-e-seed:${input.objectName}:${predicate}:${variant}`, sourceRef: null,
    capturedAtUtc: graph.nowUtc(), sourceTimezone: null, sensitivity: 'personal',
    retentionUntilUtc: null, metadata: {},
    text: `the user ${predicate} ${input.objectName} ${variant}`.trim(),
  });
  const outcome = graph.assertionService.assert({
    ownerId, actorType: 'user', actorRef: ownerId, subjectNodeId: owner.id,
    predicate, object: { kind: 'node', nodeId: object.id },
    scopeNodeId: scope === null ? null : scope.id,
    basis: 'explicit_user_statement', sensitivity: 'personal',
    validFromUtc: null, validToUtc: null, observedAtUtc: graph.nowUtc(),
    topics: [], attributes: {},
    searchText: {
      subject: 'the user', predicate, object: input.objectName, scope: variant,
    },
    evidence: [{ evidenceId: evidence.id, stance: 'supports', weight: 1 }],
  });
  if (outcome.kind === 'rejected') {
    throw new Error(`Seeding ${predicate} ${input.objectName} was rejected: ${outcome.message}`);
  }
  return {
    assertion: graph.assertions.requireAssertion(outcome.assertionId),
    evidenceId: evidence.id,
    topicKey: toTopicKey(input.objectName),
  };
}
