// Gate fixture: a non-null assertion on a Map lookup. The
// no-non-null-assertion rule must flag it.
export function nonNullAssertion(): number {
  const counts = new Map<string, number>();
  counts.set('ts', 1);
  return counts.get('ts')!;
}