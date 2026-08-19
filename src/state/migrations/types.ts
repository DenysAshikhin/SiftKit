import type { RuntimeDatabase } from '../runtime-db.js';

export interface Migration {
  readonly version: number;
  up(database: RuntimeDatabase): void;
}
