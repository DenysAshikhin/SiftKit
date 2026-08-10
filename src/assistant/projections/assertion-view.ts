import { isExplicitBasis } from '../domain/enums.js';
import type { AssertionBasis, AssertionStatus, Sensitivity } from '../domain/enums.js';
import type { RelationType } from '../domain/relation-types.js';

/**
 * An assertion with its node references already resolved to display text. Built once and shared
 * by the projection compilers and the retriever, so a fact reads the same everywhere.
 */
export interface AssertionView {
  readonly assertionId: string;
  readonly subjectText: string;
  readonly subjectIsOwner: boolean;
  readonly predicate: RelationType;
  readonly objectText: string;
  readonly scopeText: string;
  readonly status: AssertionStatus;
  readonly basis: AssertionBasis;
  readonly confidence: number;
  readonly sensitivity: Sensitivity;
  readonly pinned: boolean;
  readonly userDemoted: boolean;
  readonly lastObservedAtUtc: string;
  readonly validFromUtc: string | null;
  readonly validToUtc: string | null;
  /** Which dossier this fact belongs to. Derived once, in `AssertionViewBuilder` (Task 20). */
  readonly topicKey: string;
}

export interface CompiledDocument {
  readonly tier: 1 | 2 | 3;
  readonly topicKey: string;
  readonly title: string;
  /** Markdown body without frontmatter; the store adds frontmatter when it writes the row. */
  readonly body: string;
  readonly includedAssertionIds: readonly string[];
  readonly omittedAssertionCount: number;
  readonly sensitivity: Sensitivity;
  readonly tokenCount: number;
  readonly tokenizerId: string;
}

/** §10.3 per-document token limits. */
export const TIER_TOKEN_LIMIT = { 1: 10_000, 2: 50_000, 3: 10_000 } as const;

/** §10.3 per-tier document count limits. Tier 1 is the single profile. */
export const TIER_DOCUMENT_LIMIT = { 1: 1, 2: 25, 3: 500 } as const;

/** Plaintext projections carry `low` and `personal` only (§10.1). */
export function isProjectableInPlaintext(view: AssertionView): boolean {
  return view.sensitivity === 'low' || view.sensitivity === 'personal';
}

/**
 * Deterministic ordering: pinned first, then explicit over inferred, then confidence, then id.
 * Ties break on the id so two runs over one graph version produce identical bytes.
 */
export function compareViewsByValue(left: AssertionView, right: AssertionView): number {
  if (left.userDemoted !== right.userDemoted) return left.userDemoted ? 1 : -1;
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
  const leftExplicit = isExplicitBasis(left.basis);
  const rightExplicit = isExplicitBasis(right.basis);
  if (leftExplicit !== rightExplicit) return leftExplicit ? -1 : 1;
  if (left.confidence !== right.confidence) return right.confidence - left.confidence;
  return left.assertionId.localeCompare(right.assertionId);
}
