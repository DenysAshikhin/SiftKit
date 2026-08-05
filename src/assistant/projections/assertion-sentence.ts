import type { AssertionBasis, AssertionStatus } from '../domain/enums.js';
import { isExplicitBasis } from '../domain/enums.js';
import type { RelationType } from '../domain/relation-types.js';

export interface AssertionSentenceInput {
  readonly assertionId: string;
  readonly subjectText: string;
  /** Owner subjects are omitted from the line: the document is already about the owner. */
  readonly subjectIsOwner: boolean;
  readonly predicate: RelationType;
  readonly objectText: string;
  /** Empty when the assertion is unscoped. */
  readonly scopeText: string;
  readonly status: AssertionStatus;
  readonly basis: AssertionBasis;
  readonly confidence: number;
}

/** Third-person present phrasing, one per registered predicate. */
const PREDICATE_PHRASE = {
  OWNS: 'owns', USES: 'uses', PREFERS: 'prefers', DISLIKES: 'dislikes', AVOIDS: 'avoids',
  WORKS_ON: 'works on', CREATED: 'created', CONTRIBUTED_TO: 'contributed to',
  EMPLOYED_BY: 'is employed by', HAS_ROLE: 'holds the role of', LOCATED_IN: 'is located in',
  LIVES_IN: 'lives in', VISITED: 'visited', INTERESTED_IN: 'is interested in', READ: 'read',
  WATCHED: 'watched', PLAYED: 'played', DRIVES: 'drives', RIDES: 'rides',
  HAS_GOAL: 'has the goal', HAS_PLAN: 'has the plan', HAS_ROUTINE: 'has the routine',
  HAS_CONSTRAINT: 'has the constraint', HAS_SETTING: 'has the setting',
  HAS_COMPONENT: 'has the component', RUNS_ON: 'runs on', DEPENDS_ON: 'depends on',
  CONFIGURED_WITH: 'is configured with', COMPARED_WITH: 'was compared with',
  TESTED_WITH: 'was tested with', RESULTED_IN: 'resulted in', CAUSED_BY: 'was caused by',
  RELATED_TO: 'is related to', PART_OF: 'is part of', ABOUT: 'is about',
  MENTIONED_IN: 'was mentioned in', OBSERVED_DURING: 'was observed during',
  ASKED_ABOUT: 'asked about',
} as const satisfies Record<RelationType, string>;

/**
 * The single place an assertion becomes prose. The memory id is part of the line, so an uncited
 * projection sentence cannot exist (§10.1, §11.6).
 */
export function renderAssertionSentence(input: AssertionSentenceInput): string {
  const phrase = PREDICATE_PHRASE[input.predicate];
  const subject = input.subjectIsOwner ? '' : `${input.subjectText} `;
  const scoped = input.scopeText.trim().length === 0
    ? `${subject}${phrase} ${input.objectText}`
    : `${subject}${phrase} ${input.objectText}, for ${input.scopeText}`;
  const body = capitalize(scoped);

  if (input.status === 'disputed') {
    return `- Disputed: ${scoped}. Confidence ${format(input.confidence)}. [M:${input.assertionId}]`;
  }
  if (!isExplicitBasis(input.basis)) {
    return `- Inferred, not confirmed: ${scoped}. Confidence ${format(input.confidence)}. `
      + `[M:${input.assertionId}]`;
  }
  return `- ${body}. [M:${input.assertionId}]`;
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`;
}

function format(confidence: number): string {
  return confidence.toFixed(2);
}

