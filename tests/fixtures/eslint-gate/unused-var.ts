// Gate fixture: a `_`-prefixed variable binding that is never read. The
// no-unused-vars rule must flag it — an underscore prefix is not an opt-out.
export function unusedVariable(): number {
  const _dropped = 1;
  return 2;
}
