export interface ArchivePlan<T extends { readonly topicKey: string }> {
  readonly kept: T[];
  /** Archive topic key → merged bundles, in pop order (lowest utility first). */
  readonly archives: Map<string, T[]>;
}

/** The grouping key of a topic slug: everything before the first hyphen or slash. */
export function firstSegment(topicKey: string): string {
  const segment = topicKey.split(/[-/]/u)[0] ?? '';
  return segment.length === 0 ? 'misc' : segment;
}

/**
 * §10.3: while the tier exceeds its cap, pop the lowest-utility topic into an
 * `archive/<segment>` group. Archive documents count toward the cap, so a pop into an existing
 * group shrinks the total by one and a pop into a new group leaves it flat. If popping runs the
 * kept list dry and the cap still does not hold, every group collapses into `archive/misc`.
 * Pure and deterministic: the same sorted input always yields the same plan, and the input is
 * never mutated.
 */
export function planTier3Archives<T extends { readonly topicKey: string }>(
  sortedByUtilityDesc: readonly T[],
  limit: number,
): ArchivePlan<T> {
  const kept = [...sortedByUtilityDesc];
  const archives = new Map<string, T[]>();
  while (kept.length + archives.size > limit && kept.length > 0) {
    const lowest = kept.pop();
    if (lowest === undefined) break;
    const key = `archive/${firstSegment(lowest.topicKey)}`;
    const bucket = archives.get(key);
    if (bucket === undefined) {
      archives.set(key, [lowest]);
    } else {
      bucket.push(lowest);
    }
  }
  if (kept.length + archives.size > limit && archives.size > 1) {
    const merged = [...archives.values()].flat();
    archives.clear();
    archives.set('archive/misc', merged);
  }
  return { kept, archives };
}
