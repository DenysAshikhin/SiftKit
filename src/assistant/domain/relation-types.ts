import { z } from '../../lib/zod.js';

import type { Sensitivity } from './enums.js';
import { NODE_TYPES, type NodeType } from './node-types.js';

export const RELATION_TYPES = [
  'OWNS', 'USES', 'PREFERS', 'DISLIKES', 'AVOIDS', 'WORKS_ON', 'CREATED',
  'CONTRIBUTED_TO', 'EMPLOYED_BY', 'HAS_ROLE', 'LOCATED_IN', 'LIVES_IN', 'VISITED',
  'INTERESTED_IN', 'READ', 'WATCHED', 'PLAYED', 'DRIVES', 'RIDES', 'HAS_GOAL',
  'HAS_PLAN', 'HAS_ROUTINE', 'HAS_CONSTRAINT', 'HAS_SETTING', 'HAS_COMPONENT',
  'RUNS_ON', 'DEPENDS_ON', 'CONFIGURED_WITH', 'COMPARED_WITH', 'TESTED_WITH',
  'RESULTED_IN', 'CAUSED_BY', 'RELATED_TO', 'PART_OF', 'ABOUT', 'MENTIONED_IN',
  'OBSERVED_DURING', 'ASKED_ABOUT',
] as const;

export const RelationTypeSchema = z.enum(RELATION_TYPES);
export type RelationType = z.infer<typeof RelationTypeSchema>;

export type RelationCardinality =
  | 'many' | 'single_current' | 'single_per_scope' | 'append_only';
export type RelationTemporal = 'none' | 'optional' | 'required';
export type ProjectionBehavior = 'core' | 'dossier' | 'episodic' | 'never_project';
export type ConflictStrategy =
  | 'coexist' | 'supersede_current' | 'mark_disputed' | 'require_confirmation';

export interface RelationDefinition {
  readonly predicate: RelationType;
  readonly allowedSubjectTypes: readonly NodeType[];
  readonly allowedObjectTypes: readonly NodeType[] | 'literal';
  readonly inversePredicate: RelationType | null;
  readonly cardinality: RelationCardinality;
  readonly temporal: RelationTemporal;
  readonly defaultSensitivity: Sensitivity;
  readonly projectionBehavior: ProjectionBehavior;
  readonly conflictStrategy: ConflictStrategy;
}

const ANY: readonly NodeType[] = NODE_TYPES;
const PERSON: readonly NodeType[] = ['person'];
const PLACES: readonly NodeType[] = ['place'];
const OWNABLE: readonly NodeType[] = [
  'device', 'software', 'vehicle', 'home_asset', 'financial_account', 'account',
  'document', 'media_work', 'dataset', 'model',
];
const TOOLS: readonly NodeType[] = [
  'software', 'device', 'model', 'inference_backend', 'configuration_profile',
];
const TASTEABLE: readonly NodeType[] = [
  'software', 'device', 'model', 'inference_backend', 'configuration_profile',
  'topic', 'media_work', 'food_recipe', 'activity', 'health_topic', 'vehicle', 'place',
];
const AUTHORED: readonly NodeType[] = [
  'project', 'document', 'media_work', 'dataset', 'software',
];
const WORK_ITEMS: readonly NodeType[] = [
  'project', 'goal', 'document', 'dataset', 'benchmark',
];
const TOPICAL: readonly NodeType[] = [
  'topic', 'project', 'software', 'model', 'media_work', 'health_topic',
  'food_recipe', 'activity', 'place', 'organization',
];
const OCCURRENCES: readonly NodeType[] = ['activity', 'episode', 'event'];

function define(definition: RelationDefinition): RelationDefinition {
  return definition;
}

export const RELATION_DEFINITIONS = {
  OWNS: define({
    predicate: 'OWNS', allowedSubjectTypes: PERSON, allowedObjectTypes: OWNABLE,
    inversePredicate: null, cardinality: 'many', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'dossier', conflictStrategy: 'coexist',
  }),
  USES: define({
    predicate: 'USES', allowedSubjectTypes: PERSON, allowedObjectTypes: TOOLS,
    inversePredicate: null, cardinality: 'many', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'dossier', conflictStrategy: 'coexist',
  }),
  PREFERS: define({
    predicate: 'PREFERS', allowedSubjectTypes: PERSON, allowedObjectTypes: TASTEABLE,
    inversePredicate: null, cardinality: 'single_per_scope', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'core', conflictStrategy: 'supersede_current',
  }),
  DISLIKES: define({
    predicate: 'DISLIKES', allowedSubjectTypes: PERSON, allowedObjectTypes: TASTEABLE,
    inversePredicate: null, cardinality: 'single_per_scope', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'dossier', conflictStrategy: 'supersede_current',
  }),
  AVOIDS: define({
    predicate: 'AVOIDS', allowedSubjectTypes: PERSON, allowedObjectTypes: TASTEABLE,
    inversePredicate: null, cardinality: 'single_per_scope', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'dossier', conflictStrategy: 'supersede_current',
  }),
  WORKS_ON: define({
    predicate: 'WORKS_ON', allowedSubjectTypes: PERSON, allowedObjectTypes: WORK_ITEMS,
    inversePredicate: null, cardinality: 'many', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'core', conflictStrategy: 'coexist',
  }),
  CREATED: define({
    predicate: 'CREATED', allowedSubjectTypes: PERSON, allowedObjectTypes: AUTHORED,
    inversePredicate: null, cardinality: 'append_only', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'dossier', conflictStrategy: 'coexist',
  }),
  CONTRIBUTED_TO: define({
    predicate: 'CONTRIBUTED_TO', allowedSubjectTypes: PERSON, allowedObjectTypes: AUTHORED,
    inversePredicate: null, cardinality: 'many', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'dossier', conflictStrategy: 'coexist',
  }),
  EMPLOYED_BY: define({
    predicate: 'EMPLOYED_BY', allowedSubjectTypes: ['person', 'episode'],
    allowedObjectTypes: ['organization'], inversePredicate: null,
    cardinality: 'single_current', temporal: 'required',
    defaultSensitivity: 'personal', projectionBehavior: 'core', conflictStrategy: 'supersede_current',
  }),
  HAS_ROLE: define({
    predicate: 'HAS_ROLE', allowedSubjectTypes: ['person', 'episode'],
    allowedObjectTypes: 'literal', inversePredicate: null,
    cardinality: 'single_current', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'core', conflictStrategy: 'supersede_current',
  }),
  LOCATED_IN: define({
    predicate: 'LOCATED_IN',
    allowedSubjectTypes: ['device', 'home_asset', 'vehicle', 'organization', 'event', 'episode'],
    allowedObjectTypes: PLACES, inversePredicate: null,
    cardinality: 'single_current', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'dossier', conflictStrategy: 'supersede_current',
  }),
  LIVES_IN: define({
    predicate: 'LIVES_IN', allowedSubjectTypes: PERSON, allowedObjectTypes: PLACES,
    inversePredicate: null, cardinality: 'single_current', temporal: 'optional',
    defaultSensitivity: 'sensitive', projectionBehavior: 'dossier', conflictStrategy: 'supersede_current',
  }),
  VISITED: define({
    predicate: 'VISITED', allowedSubjectTypes: PERSON, allowedObjectTypes: PLACES,
    inversePredicate: null, cardinality: 'append_only', temporal: 'required',
    defaultSensitivity: 'sensitive', projectionBehavior: 'episodic', conflictStrategy: 'coexist',
  }),
  INTERESTED_IN: define({
    predicate: 'INTERESTED_IN', allowedSubjectTypes: PERSON, allowedObjectTypes: TOPICAL,
    inversePredicate: null, cardinality: 'many', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'dossier', conflictStrategy: 'coexist',
  }),
  READ: define({
    predicate: 'READ', allowedSubjectTypes: PERSON,
    allowedObjectTypes: ['media_work', 'document'], inversePredicate: null,
    cardinality: 'append_only', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'episodic', conflictStrategy: 'coexist',
  }),
  WATCHED: define({
    predicate: 'WATCHED', allowedSubjectTypes: PERSON, allowedObjectTypes: ['media_work'],
    inversePredicate: null, cardinality: 'append_only', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'episodic', conflictStrategy: 'coexist',
  }),
  PLAYED: define({
    predicate: 'PLAYED', allowedSubjectTypes: PERSON,
    allowedObjectTypes: ['media_work', 'software'], inversePredicate: null,
    cardinality: 'append_only', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'episodic', conflictStrategy: 'coexist',
  }),
  DRIVES: define({
    predicate: 'DRIVES', allowedSubjectTypes: PERSON, allowedObjectTypes: ['vehicle'],
    inversePredicate: null, cardinality: 'many', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'dossier', conflictStrategy: 'coexist',
  }),
  RIDES: define({
    predicate: 'RIDES', allowedSubjectTypes: PERSON, allowedObjectTypes: ['vehicle'],
    inversePredicate: null, cardinality: 'many', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'dossier', conflictStrategy: 'coexist',
  }),
  HAS_GOAL: define({
    predicate: 'HAS_GOAL', allowedSubjectTypes: PERSON, allowedObjectTypes: ['goal'],
    inversePredicate: null, cardinality: 'many', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'core', conflictStrategy: 'coexist',
  }),
  HAS_PLAN: define({
    predicate: 'HAS_PLAN', allowedSubjectTypes: ['person', 'project', 'goal'],
    allowedObjectTypes: ['goal', 'project', 'episode'], inversePredicate: null,
    cardinality: 'many', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'dossier', conflictStrategy: 'coexist',
  }),
  HAS_ROUTINE: define({
    predicate: 'HAS_ROUTINE', allowedSubjectTypes: PERSON, allowedObjectTypes: ['routine'],
    inversePredicate: null, cardinality: 'many', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'core', conflictStrategy: 'supersede_current',
  }),
  // Two incompatible explicit constraints are the design's row-four conflict case, so this
  // predicate is exclusive per scope and disputes rather than silently superseding.
  HAS_CONSTRAINT: define({
    predicate: 'HAS_CONSTRAINT', allowedSubjectTypes: ['person', 'project', 'goal'],
    allowedObjectTypes: 'literal', inversePredicate: null,
    cardinality: 'single_per_scope', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'core', conflictStrategy: 'mark_disputed',
  }),
  HAS_SETTING: define({
    predicate: 'HAS_SETTING',
    allowedSubjectTypes: ['software', 'device', 'configuration_profile', 'model', 'inference_backend'],
    allowedObjectTypes: 'literal', inversePredicate: null,
    cardinality: 'single_per_scope', temporal: 'optional',
    defaultSensitivity: 'low', projectionBehavior: 'dossier', conflictStrategy: 'supersede_current',
  }),
  HAS_COMPONENT: define({
    predicate: 'HAS_COMPONENT',
    allowedSubjectTypes: ['device', 'software', 'vehicle', 'home_asset', 'project'],
    allowedObjectTypes: ['device', 'software', 'home_asset'], inversePredicate: 'PART_OF',
    cardinality: 'many', temporal: 'optional',
    defaultSensitivity: 'low', projectionBehavior: 'dossier', conflictStrategy: 'coexist',
  }),
  RUNS_ON: define({
    predicate: 'RUNS_ON', allowedSubjectTypes: ['software', 'model', 'project'],
    allowedObjectTypes: ['device', 'software', 'inference_backend'], inversePredicate: null,
    cardinality: 'many', temporal: 'optional',
    defaultSensitivity: 'low', projectionBehavior: 'dossier', conflictStrategy: 'coexist',
  }),
  DEPENDS_ON: define({
    predicate: 'DEPENDS_ON', allowedSubjectTypes: ['software', 'project', 'model', 'goal'],
    allowedObjectTypes: ['software', 'project', 'model', 'inference_backend', 'dataset'],
    inversePredicate: null, cardinality: 'many', temporal: 'optional',
    defaultSensitivity: 'low', projectionBehavior: 'dossier', conflictStrategy: 'coexist',
  }),
  CONFIGURED_WITH: define({
    predicate: 'CONFIGURED_WITH',
    allowedSubjectTypes: ['software', 'model', 'inference_backend', 'device'],
    allowedObjectTypes: ['configuration_profile'], inversePredicate: null,
    cardinality: 'single_current', temporal: 'optional',
    defaultSensitivity: 'low', projectionBehavior: 'dossier', conflictStrategy: 'supersede_current',
  }),
  COMPARED_WITH: define({
    predicate: 'COMPARED_WITH',
    allowedSubjectTypes: ['model', 'software', 'inference_backend', 'benchmark'],
    allowedObjectTypes: ['model', 'software', 'inference_backend'],
    inversePredicate: 'COMPARED_WITH', cardinality: 'many', temporal: 'optional',
    defaultSensitivity: 'low', projectionBehavior: 'episodic', conflictStrategy: 'coexist',
  }),
  TESTED_WITH: define({
    predicate: 'TESTED_WITH', allowedSubjectTypes: ['model', 'software', 'project'],
    allowedObjectTypes: ['benchmark', 'dataset', 'configuration_profile'],
    inversePredicate: null, cardinality: 'many', temporal: 'optional',
    defaultSensitivity: 'low', projectionBehavior: 'episodic', conflictStrategy: 'coexist',
  }),
  RESULTED_IN: define({
    predicate: 'RESULTED_IN',
    allowedSubjectTypes: ['event', 'episode', 'activity', 'benchmark'],
    allowedObjectTypes: ['event', 'episode', 'document', 'goal'],
    inversePredicate: 'CAUSED_BY', cardinality: 'append_only', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'episodic', conflictStrategy: 'coexist',
  }),
  CAUSED_BY: define({
    predicate: 'CAUSED_BY',
    allowedSubjectTypes: ['event', 'episode', 'document', 'goal'],
    allowedObjectTypes: ['event', 'episode', 'activity', 'benchmark'],
    inversePredicate: 'RESULTED_IN', cardinality: 'many', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'episodic', conflictStrategy: 'coexist',
  }),
  RELATED_TO: define({
    predicate: 'RELATED_TO', allowedSubjectTypes: ANY, allowedObjectTypes: ANY,
    inversePredicate: 'RELATED_TO', cardinality: 'many', temporal: 'none',
    defaultSensitivity: 'low', projectionBehavior: 'never_project', conflictStrategy: 'coexist',
  }),
  PART_OF: define({
    predicate: 'PART_OF', allowedSubjectTypes: ['device', 'software', 'home_asset'],
    allowedObjectTypes: ['device', 'software', 'vehicle', 'home_asset', 'project'],
    inversePredicate: 'HAS_COMPONENT', cardinality: 'many', temporal: 'none',
    defaultSensitivity: 'low', projectionBehavior: 'dossier', conflictStrategy: 'coexist',
  }),
  ABOUT: define({
    predicate: 'ABOUT',
    allowedSubjectTypes: ['episode', 'event', 'document', 'activity', 'question_topic'],
    allowedObjectTypes: ANY, inversePredicate: null, cardinality: 'many', temporal: 'none',
    defaultSensitivity: 'personal', projectionBehavior: 'dossier', conflictStrategy: 'coexist',
  }),
  MENTIONED_IN: define({
    predicate: 'MENTIONED_IN', allowedSubjectTypes: ANY,
    allowedObjectTypes: ['document', 'episode', 'event'], inversePredicate: null,
    cardinality: 'append_only', temporal: 'none',
    defaultSensitivity: 'personal', projectionBehavior: 'never_project', conflictStrategy: 'coexist',
  }),
  OBSERVED_DURING: define({
    predicate: 'OBSERVED_DURING', allowedSubjectTypes: ANY, allowedObjectTypes: OCCURRENCES,
    inversePredicate: null, cardinality: 'append_only', temporal: 'required',
    defaultSensitivity: 'personal', projectionBehavior: 'episodic', conflictStrategy: 'coexist',
  }),
  ASKED_ABOUT: define({
    predicate: 'ASKED_ABOUT', allowedSubjectTypes: ['question_topic'], allowedObjectTypes: ANY,
    inversePredicate: null, cardinality: 'many', temporal: 'none',
    defaultSensitivity: 'personal', projectionBehavior: 'never_project', conflictStrategy: 'coexist',
  }),
} as const satisfies Record<RelationType, RelationDefinition>;

/** Throws on any predicate outside the registry. Model output must go through this. */
export function getRelationDefinition(predicate: string): RelationDefinition {
  const parsed = RelationTypeSchema.safeParse(predicate);
  if (!parsed.success) {
    throw new Error(`Unknown predicate: ${predicate}`);
  }
  return RELATION_DEFINITIONS[parsed.data];
}

export function isRelationType(predicate: string): predicate is RelationType {
  return RelationTypeSchema.safeParse(predicate).success;
}

export function isNodeTypeAllowedAsSubject(predicate: RelationType, nodeType: NodeType): boolean {
  return RELATION_DEFINITIONS[predicate].allowedSubjectTypes.includes(nodeType);
}

export function isNodeTypeAllowedAsObject(predicate: RelationType, nodeType: NodeType): boolean {
  const allowed = RELATION_DEFINITIONS[predicate].allowedObjectTypes;
  return allowed !== 'literal' && allowed.includes(nodeType);
}

export function allowsLiteralObject(predicate: RelationType): boolean {
  return RELATION_DEFINITIONS[predicate].allowedObjectTypes === 'literal';
}
