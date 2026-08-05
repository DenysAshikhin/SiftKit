import { randomUUID } from 'node:crypto';

/**
 * Opaque identifier source. `prefix` names the row family (`node`, `ast`, `ev`, ...)
 * so an id is self-describing in a log or an export.
 */
export interface IdGenerator {
  next(prefix: string): string;
}

export class RandomIdGenerator implements IdGenerator {
  next(prefix: string): string {
    return `${prefix}_${randomUUID().replace(/-/g, '')}`;
  }
}

/** Test generator. One shared counter so ordering across families stays observable. */
export class SequentialIdGenerator implements IdGenerator {
  private counter = 0;

  next(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${String(this.counter).padStart(4, '0')}`;
  }
}