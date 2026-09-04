import type { RuntimeDatabase } from '../database-handle.js';

export interface Migration {
  readonly version: number;
  readonly rebuildsTables?: boolean;
  up(database: RuntimeDatabase): void;
}
