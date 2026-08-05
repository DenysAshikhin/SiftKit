import { BASIS_CONFIDENCE_CEILING } from '../domain/confidence.js';
import { isExplicitBasis, type AssertionBasis, type Sensitivity } from '../domain/enums.js';
import { normalizeLiteralValue, type AssertionObjectRef } from '../domain/keys.js';
import {
  allowsLiteralObject, isNodeTypeAllowedAsObject, isNodeTypeAllowedAsSubject, isRelationType,
  RELATION_DEFINITIONS, type RelationType,
} from '../domain/relation-types.js';
import type { NodeStore } from '../storage/node-store.js';
import type { PolicyStore } from '../storage/policy-store.js';

export type ValidationCode =
  | 'unknown_predicate'
  | 'subject_unresolved'
  | 'object_unresolved'
  | 'scope_unresolved'
  | 'subject_type_not_allowed'
  | 'object_type_not_allowed'
  | 'scope_type_not_allowed'
  | 'literal_object_not_allowed'
  | 'node_object_not_allowed'
  | 'literal_value_invalid'
  | 'confidence_above_ceiling'
  | 'confidence_out_of_range'
  | 'secret_prohibited'
  | 'blocked_topic'
  | 'temporal_window_required'
  | 'temporal_window_malformed'
  | 'temporal_window_inconsistent';

export type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ValidationCode; readonly message: string };

export interface AssertionValidationRequest {
  readonly ownerId: string;
  readonly subjectNodeId: string;
  readonly predicate: string;
  readonly object: AssertionObjectRef;
  readonly scopeNodeId: string | null;
  readonly basis: AssertionBasis;
  readonly confidence: number;
  readonly sensitivity: Sensitivity;
  readonly validFromUtc: string | null;
  readonly validToUtc: string | null;
  /** Topic keys this assertion is about, checked against `never_infer_topic` policies. */
  readonly topics: readonly string[];
}

/** The only node type permitted as an assertion scope (§4.8). */
const SCOPE_NODE_TYPE = 'preference_context';

function reject(code: ValidationCode, message: string): ValidationResult {
  return { ok: false, code, message };
}

/**
 * Deterministic gate between a proposal and the graph. Models propose; this decides.
 * Returns a typed result so the caller can record the reason rather than swallowing an exception.
 */
export class AssertionValidator {
  constructor(
    private readonly nodes: NodeStore,
    private readonly policies: PolicyStore,
  ) {}

  validate(request: AssertionValidationRequest): ValidationResult {
    if (request.sensitivity === 'secret_prohibited') {
      return reject('secret_prohibited', 'Secret-prohibited content is never written to the graph.');
    }
    if (!isRelationType(request.predicate)) {
      return reject('unknown_predicate', `Predicate ${request.predicate} is not in the registry.`);
    }
    const definition = RELATION_DEFINITIONS[request.predicate];

    const subject = this.nodes.getNode(request.subjectNodeId);
    if (subject === null || subject.status !== 'active') {
      return reject('subject_unresolved', `Subject node ${request.subjectNodeId} is not active.`);
    }
    if (!isNodeTypeAllowedAsSubject(request.predicate, subject.type)) {
      return reject(
        'subject_type_not_allowed',
        `${request.predicate} does not accept a ${subject.type} subject.`,
      );
    }

    const objectResult = this.validateObject(request, request.predicate);
    if (!objectResult.ok) return objectResult;

    if (request.scopeNodeId !== null) {
      const scope = this.nodes.getNode(request.scopeNodeId);
      if (scope === null || scope.status !== 'active') {
        return reject('scope_unresolved', `Scope node ${request.scopeNodeId} is not active.`);
      }
      if (scope.type !== SCOPE_NODE_TYPE) {
        return reject(
          'scope_type_not_allowed',
          `An assertion scope must be a ${SCOPE_NODE_TYPE} node, received ${scope.type}.`,
        );
      }
    }

    if (!Number.isFinite(request.confidence) || request.confidence < 0 || request.confidence > 1) {
      return reject('confidence_out_of_range', 'Confidence must be within [0, 1].');
    }
    if (request.confidence > BASIS_CONFIDENCE_CEILING[request.basis]) {
      return reject(
        'confidence_above_ceiling',
        `Confidence ${request.confidence} exceeds the ${request.basis} ceiling.`,
      );
    }

    if (!isExplicitBasis(request.basis)) {
      for (const topic of request.topics) {
        if (this.policies.isTopicBlockedFromInference(request.ownerId, topic)) {
          return reject('blocked_topic', `A never_infer_topic policy blocks topic ${topic}.`);
        }
      }
    }

    return this.validateTemporal(request, definition.temporal);
  }

  private validateObject(
    request: AssertionValidationRequest,
    predicate: RelationType,
  ): ValidationResult {
    const literalAllowed = allowsLiteralObject(predicate);

    if (request.object.kind === 'literal') {
      if (!literalAllowed) {
        return reject(
          'literal_object_not_allowed',
          `${predicate} requires a node object, not a literal.`,
        );
      }
      try {
        normalizeLiteralValue(request.object.valueType, request.object.value);
      } catch (error) {
        return reject(
          'literal_value_invalid',
          error instanceof Error ? error.message : 'Literal value is invalid.',
        );
      }
      return { ok: true };
    }

    if (literalAllowed) {
      return reject(
        'node_object_not_allowed',
        `${predicate} requires a literal object, not a node.`,
      );
    }
    const object = this.nodes.getNode(request.object.nodeId);
    if (object === null || object.status !== 'active') {
      return reject('object_unresolved', `Object node ${request.object.nodeId} is not active.`);
    }
    if (!isNodeTypeAllowedAsObject(predicate, object.type)) {
      return reject(
        'object_type_not_allowed',
        `${predicate} does not accept a ${object.type} object.`,
      );
    }
    return { ok: true };
  }

  private validateTemporal(
    request: AssertionValidationRequest,
    temporal: 'none' | 'optional' | 'required',
  ): ValidationResult {
    const from = request.validFromUtc;
    const to = request.validToUtc;

    for (const [label, value] of [['validFromUtc', from], ['validToUtc', to]] as const) {
      if (value !== null && Number.isNaN(Date.parse(value))) {
        return reject('temporal_window_malformed', `${label} is not a parseable instant: ${value}`);
      }
    }
    if (temporal === 'required' && from === null) {
      return reject(
        'temporal_window_required',
        `${request.predicate} requires a validFromUtc.`,
      );
    }
    if (from !== null && to !== null && Date.parse(to) <= Date.parse(from)) {
      return reject(
        'temporal_window_inconsistent',
        'validToUtc must be strictly after validFromUtc.',
      );
    }
    return { ok: true };
  }
}