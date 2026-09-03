import { z } from '../../lib/zod.js';
import { ObjectValueTypeSchema } from './enums.js';
import type { NodeType } from './node-types.js';
import {
  RELATION_DEFINITIONS, RELATION_TYPES, type RelationType,
} from './relation-types.js';

/** An assertion scope is always a preference context; `AssertionValidator` enforces the same. */
export const SCOPE_NODE_TYPE = 'preference_context';

/** A literal a model may propose is a scalar: a recursive value has no finite grammar. */
const ProposedLiteralValueSchema = z.union([
  z.string(), z.number(), z.boolean(), z.null(),
]);

const ScopeRefSchema = z.object({
  nodeType: z.literal(SCOPE_NODE_TYPE),
  displayName: z.string().min(1),
}).strict();

/**
 * `z.enum` needs at least one member, so a single allowed type becomes a literal. A relation with
 * no allowed types is a broken definition and must not silently accept everything.
 */
function nodeTypeSchema(predicate: RelationType, role: string, types: readonly NodeType[]) {
  const [first, ...rest] = types;
  if (first === undefined) {
    throw new Error(`${predicate} allows no ${role} node type.`);
  }
  return rest.length === 0 ? z.literal(first) : z.enum([first, ...rest]);
}

function subjectSchema(predicate: RelationType) {
  return z.object({
    nodeType: nodeTypeSchema(predicate, 'subject', RELATION_DEFINITIONS[predicate].allowedSubjectTypes),
    displayName: z.string().min(1),
  }).strict();
}

/**
 * Each predicate takes either a node object or a literal one, never both, so the wire type is the
 * one the relation table allows. The model cannot express the mismatch the validator would reject.
 */
function objectSchema(predicate: RelationType) {
  const allowed = RELATION_DEFINITIONS[predicate].allowedObjectTypes;
  if (allowed === 'literal') {
    return z.object({
      kind: z.literal('literal'),
      valueType: ObjectValueTypeSchema,
      value: ProposedLiteralValueSchema,
    }).strict();
  }
  return z.object({
    kind: z.literal('unresolved'),
    nodeType: nodeTypeSchema(predicate, 'object', allowed),
    displayName: z.string().min(1),
  }).strict();
}

/**
 * One variant per relation type, each carrying only the subject, object, and scope shapes that
 * relation accepts. Generated from `RELATION_DEFINITIONS` so the wire contract and the validator
 * can never disagree: a predicate added to the table appears here automatically.
 */
export function buildProposedStatementSchema<Extra extends z.ZodRawShape>(extra: Extra) {
  const variants = RELATION_TYPES.map((predicate) => z.object({
    predicate: z.literal(predicate),
    subject: subjectSchema(predicate),
    object: objectSchema(predicate),
    scope: ScopeRefSchema.nullable(),
    rationale: z.string().min(1),
    /** A suggestion only; the basis ceiling and the gate decide the stored confidence. */
    suggestedConfidence: z.number().min(0).max(1),
    ...extra,
  }).strict());
  const [first, second, ...rest] = variants;
  if (first === undefined || second === undefined) {
    throw new Error('The relation table must define at least two relation types.');
  }
  return z.union([first, second, ...rest]);
}
