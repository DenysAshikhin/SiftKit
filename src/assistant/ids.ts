import { randomUUID } from 'node:crypto';

/**
 * The row families that own an id. Closed on purpose: a mistyped prefix would otherwise produce a
 * valid-looking id in the wrong family.
 */
export type IdPrefix =
  | 'node' | 'alias' | 'merge' | 'ast' | 'ev' | 'blob' | 'mut' | 'audit' | 'pol'
  | 'obs' | 'cand' | 'memproj' | 'job' | 'question' | 'question_feedback' | 'retrieval_usage'
  | 'aevt' | 'asess';

/**
 * Opaque identifier source. `prefix` names the row family so an id is self-describing in a log
 * or an export.
 */
export interface IdGenerator {
  next(prefix: IdPrefix): string;
}

export class RandomIdGenerator implements IdGenerator {
  next(prefix: IdPrefix): string {
    return `${prefix}_${randomUUID().replace(/-/g, '')}`;
  }
}

/** Test generator. One shared counter so ordering across families stays observable. */
export class SequentialIdGenerator implements IdGenerator {
  private counter = 0;

  next(prefix: IdPrefix): string {
    this.counter += 1;
    return `${prefix}_${String(this.counter).padStart(4, '0')}`;
  }
}
