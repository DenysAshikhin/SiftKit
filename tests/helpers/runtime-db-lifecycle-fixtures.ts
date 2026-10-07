import path from 'node:path';

import { z } from '../../src/lib/zod.ts';
import {
  getRuntimeDatabase,
} from '../../src/state/runtime-db.ts';
import { createManagedTempDir } from './temp-dirs.ts';

const ValueRowsSchema = z.array(z.object({ value: z.string() }));

export function twoPaths(prefix: string): { firstPath: string; secondPath: string } {
  const root = createManagedTempDir(prefix);
  return { firstPath: path.join(root, 'a', 'runtime.sqlite'), secondPath: path.join(root, 'b', 'runtime.sqlite') };
}

export function readValues(database: ReturnType<typeof getRuntimeDatabase>): string[] {
  return ValueRowsSchema.parse(database.prepare('SELECT value FROM audit_value ORDER BY value').all())
    .map((row) => row.value);
}

