/**
 * Names that always mean the owner, whatever the owner is actually called. They are seeded onto
 * the owner person node as aliases so `EntityResolver` resolves them like any other alias, and
 * `CandidatePromoter` uses the same list to attach the owner's canonical key when the node has
 * not been bootstrapped yet.
 */
export const OWNER_PRONOUN_ALIASES = ['the user', 'user', 'me', 'i', 'myself'] as const;

/**
 * How far a name may sit from a known owner alias and still be worth asking about. Two edits
 * catches the corruptions OCR actually produces — `denyz`, `demyus`, `dengy` off `denys` — while
 * leaving unrelated names alone. Widening it is not a free win: a false positive here writes a
 * permanent owner alias once the owner answers yes.
 */
export const NEAR_OWNER_ALIAS_MAX_DISTANCE = 2;

/** Below this length two edits is most of the word, so the distance stops meaning anything. */
export const NEAR_OWNER_ALIAS_MIN_LENGTH = 4;

/**
 * Levenshtein distance, stopping once it provably exceeds `max`. Two rolling rows; each cell is
 * derived from the values carried through the loop, so no cell is ever read by index.
 */
export function editDistanceWithin(left: string, right: string, max: number): boolean {
  if (Math.abs(left.length - right.length) > max) return false;
  const rightChars = Array.from(right);
  let previous = Array.from({ length: rightChars.length + 1 }, (_unused, index) => index);
  let lastCell = rightChars.length;
  for (const [rowIndex, leftChar] of Array.from(left).entries()) {
    const current = [rowIndex + 1];
    let diagonal = rowIndex;
    let insertion = rowIndex + 1;
    let best = insertion;
    for (const [columnIndex, above] of previous.slice(1).entries()) {
      const substitution = diagonal + (leftChar === rightChars[columnIndex] ? 0 : 1);
      const distance = Math.min(substitution, above + 1, insertion + 1);
      current.push(distance);
      diagonal = above;
      insertion = distance;
      best = Math.min(best, distance);
    }
    if (best > max) return false;
    previous = current;
    lastCell = insertion;
  }
  return lastCell <= max;
}

/**
 * Whether `name` looks like a corrupted spelling of one of the owner's names. Callers must first
 * establish that `name` matches no existing alias exactly: a name the graph already knows is
 * answered, not a question. Pronoun aliases are resolution shortcuts, not names, so they are
 * never a similarity target.
 */
export function isNearOwnerAlias(name: string, ownerAliases: readonly string[]): boolean {
  if (name.length < NEAR_OWNER_ALIAS_MIN_LENGTH) return false;
  return ownerAliases.some((alias) => alias.length >= NEAR_OWNER_ALIAS_MIN_LENGTH
    && alias !== name
    && !OWNER_PRONOUN_ALIASES.some((pronoun) => pronoun === alias)
    && editDistanceWithin(name, alias, NEAR_OWNER_ALIAS_MAX_DISTANCE));
}
