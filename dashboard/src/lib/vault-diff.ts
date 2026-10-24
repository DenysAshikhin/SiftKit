export interface DiffOp {
  readonly kind: 'ctx' | 'add' | 'del';
  readonly text: string;
}

export type DiffRow = DiffOp | { readonly kind: 'gap' };

/** Past this many DP cells the diff degrades to delete-all/add-all instead of stalling the UI. */
const MAX_DP_CELLS = 4_000_000;
const CONTEXT_LINES = 3;

const each = (kind: DiffOp['kind'], lines: readonly string[]): DiffOp[] => lines.map((text) => ({ kind, text }));

/** LCS line diff with common ends trimmed first; a replaced line reads as delete then add. */
export function lineDiff(before: readonly string[], after: readonly string[]): DiffOp[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) { endBefore -= 1; endAfter -= 1; }
  const left = before.slice(start, endBefore);
  const right = after.slice(start, endAfter);
  const middle: DiffOp[] = [];
  if (left.length * right.length > MAX_DP_CELLS) {
    middle.push(...each('del', left), ...each('add', right));
  } else {
    const width = right.length + 1;
    const dp = new Uint32Array((left.length + 1) * width);
    const at = (i: number, j: number) => dp[i * width + j] ?? 0;
    for (let i = left.length - 1; i >= 0; i -= 1) {
      for (let j = right.length - 1; j >= 0; j -= 1) {
        dp[i * width + j] = left[i] === right[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
      }
    }
    let i = 0;
    let j = 0;
    while (i < left.length || j < right.length) {
      const leftLine = left[i];
      const rightLine = right[j];
      if (leftLine !== undefined && leftLine === rightLine) { middle.push({ kind: 'ctx', text: leftLine }); i += 1; j += 1; }
      else if (leftLine !== undefined && (rightLine === undefined || at(i + 1, j) >= at(i, j + 1))) { middle.push({ kind: 'del', text: leftLine }); i += 1; }
      else { middle.push({ kind: 'add', text: rightLine ?? '' }); j += 1; }
    }
  }
  return [...each('ctx', before.slice(0, start)), ...middle, ...each('ctx', before.slice(endBefore))];
}

/** Collapsing keeps three context lines around every change and folds each elided run into one gap row. */
export function diffRows(ops: readonly DiffOp[], collapse: boolean): DiffRow[] {
  if (!collapse) return [...ops];
  const keep = new Set<number>();
  ops.forEach((op, index) => {
    if (op.kind !== 'ctx') for (let delta = -CONTEXT_LINES; delta <= CONTEXT_LINES; delta += 1) keep.add(index + delta);
  });
  const rows: DiffRow[] = [];
  ops.forEach((op, index) => {
    if (keep.has(index)) rows.push(op);
    else if (rows.at(-1)?.kind !== 'gap') rows.push({ kind: 'gap' });
  });
  return rows;
}
