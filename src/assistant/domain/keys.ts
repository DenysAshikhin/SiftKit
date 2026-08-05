import { createHash } from 'node:crypto';

import { z } from '../../lib/zod.js';
import { isJsonObject, JsonValueSchema, type JsonValue } from '../../lib/json-types.js';
import { ObjectValueTypeSchema, type ObjectValueType } from './enums.js';
import { NodeTypeSchema } from './node-types.js';
import type { RelationType } from './relation-types.js';

// ASCII unit separator (U+001F): cannot occur in an id, a predicate, or a normalized
// literal, so no two distinct tuples can concatenate to the same string.
const KEY_SEPARATOR = '\u001f';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Trim, NFC-normalize, collapse internal whitespace, lowercase. */
export function normalizeAliasText(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function shortestNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`Literal number must be finite: ${value}`);
  }
  return String(value);
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (isJsonObject(value)) {
    const keys = Object.keys(value).sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Deterministic normalization of a literal object value, keyed off its declared type.
 * A value that cannot satisfy its declared type throws — silently coercing would let two
 * different facts collapse onto one assertion key.
 */
export function normalizeLiteralValue(valueType: ObjectValueType, value: JsonValue): string {
  switch (valueType) {
    case 'string': {
      if (typeof value !== 'string') throw new Error('Literal string expects a string value.');
      return normalizeAliasText(value);
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new Error('Literal integer expects an integer value.');
      }
      return String(value);
    }
    case 'number': {
      if (typeof value !== 'number') throw new Error('Literal number expects a numeric value.');
      return shortestNumber(value);
    }
    case 'boolean': {
      if (typeof value !== 'boolean') throw new Error('Literal boolean expects a boolean value.');
      return value ? 'true' : 'false';
    }
    case 'date': {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new Error('Literal date expects YYYY-MM-DD.');
      }
      return value;
    }
    case 'datetime': {
      if (typeof value !== 'string') throw new Error('Literal datetime expects a string.');
      const parsed = Date.parse(value);
      if (Number.isNaN(parsed)) throw new Error(`Literal datetime is unparseable: ${value}`);
      return new Date(parsed).toISOString();
    }
    case 'duration': {
      if (typeof value !== 'string' || !/^P/.test(value)) {
        throw new Error('Literal duration expects an ISO-8601 duration.');
      }
      return value;
    }
    case 'quantity': {
      if (!isJsonObject(value)) throw new Error('Literal quantity expects { amount, unit }.');
      const amount = value.amount;
      const unit = value.unit;
      if (typeof amount !== 'number' || typeof unit !== 'string') {
        throw new Error('Literal quantity expects { amount: number, unit: string }.');
      }
      return `${shortestNumber(amount)} ${unit.trim().toLowerCase()}`;
    }
    case 'json': {
      return canonicalJson(value);
    }
  }
}

export type AssertionObjectRef =
  | { readonly kind: 'node'; readonly nodeId: string }
  | { readonly kind: 'literal'; readonly valueType: ObjectValueType; readonly value: JsonValue };

export interface AssertionKeyInput {
  readonly ownerId: string;
  readonly subjectNodeId: string;
  readonly predicate: RelationType;
  readonly object: AssertionObjectRef;
  readonly scopeNodeId: string | null;
}

function assertionObjectKey(object: AssertionObjectRef): string {
  return object.kind === 'node'
    ? `node:${object.nodeId}`
    : `literal:${object.valueType}:${normalizeLiteralValue(object.valueType, object.value)}`;
}

/**
 * SHA-256 over ownerId, subjectNodeId, predicate, objectKey, scopeNodeId.
 * Backs `graph_assertions_active_key_uq`: at most one live assertion of this exact shape.
 */
export function buildAssertionKey(input: AssertionKeyInput): string {
  return sha256Hex([
    input.ownerId,
    input.subjectNodeId,
    input.predicate,
    assertionObjectKey(input.object),
    input.scopeNodeId ?? '',
  ].join(KEY_SEPARATOR));
}

/**
 * A reference to a node that has not been resolved to an id yet — no `kind` discriminator.
 * The schema is the single definition: every producer (model output) and consumer (stored
 * candidate JSON) validates against it, and the type is inferred from it.
 */
export const UnresolvedNodeRefSchema = z.object({
  nodeType: NodeTypeSchema,
  displayName: z.string().min(1),
}).strict();
export type UnresolvedNodeRef = z.infer<typeof UnresolvedNodeRefSchema>;

/** The object side of a candidate: an unresolved node or a literal value. */
export const CandidateObjectRefSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('unresolved'),
    nodeType: NodeTypeSchema,
    displayName: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal('literal'),
    valueType: ObjectValueTypeSchema,
    value: JsonValueSchema,
  }).strict(),
]);
export type CandidateObjectRef = z.infer<typeof CandidateObjectRefSchema>;

export interface CandidateFingerprintInput {
  readonly ownerId: string;
  readonly subject: UnresolvedNodeRef;
  readonly predicate: RelationType;
  readonly object: CandidateObjectRef;
  readonly scope: UnresolvedNodeRef | null;
}

function unresolvedKey(ref: UnresolvedNodeRef): string {
  return `${ref.nodeType}:${normalizeAliasText(ref.displayName)}`;
}

/**
 * Same tuple shape as the assertion key but built from unresolved references, so duplicate
 * proposals collide before entity resolution runs.
 */
export function buildCandidateFingerprint(input: CandidateFingerprintInput): string {
  const objectKey = input.object.kind === 'unresolved'
    ? `node:${unresolvedKey(input.object)}`
    : `literal:${input.object.valueType}:${normalizeLiteralValue(input.object.valueType, input.object.value)}`;
  return sha256Hex([
    input.ownerId,
    unresolvedKey(input.subject),
    input.predicate,
    objectKey,
    input.scope === null ? '' : unresolvedKey(input.scope),
  ].join(KEY_SEPARATOR));
}

/** SHA-256 of text after Unicode NFC and line-ending normalization, so re-ingest deduplicates. */
export function hashTextContent(text: string): string {
  return sha256Hex(text.normalize('NFC').replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
}

/** SHA-256 of raw payload bytes. */
export function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}