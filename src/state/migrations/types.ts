import type { RuntimeDatabase } from '../database-handle.js';

export interface Migration {
  readonly version: number;
  up(database: RuntimeDatabase): void;
}
