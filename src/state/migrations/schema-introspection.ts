import { z } from '../../lib/zod.js';
import type { RuntimeDatabase } from '../runtime-db.js';

const ExistsFlagRowSchema = z.object({ exists_flag: z.number().nullable() });

export function tableExists(database: RuntimeDatabase, name: string): boolean {
  const rawRow = database.prepare(`
    SELECT 1 AS exists_flag
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `).get(name);
  const row = rawRow == null ? undefined : ExistsFlagRowSchema.parse(rawRow);
  return Number(row?.exists_flag) === 1;
}

export function tableHasColumn(database: RuntimeDatabase, tableName: string, columnName: string): boolean {
  if (!tableExists(database, tableName)) {
    return false;
  }
  const escapedTableName = String(tableName).replace(/'/gu, "''");
  const rawRow = database.prepare(`
    SELECT 1 AS exists_flag
    FROM pragma_table_info('${escapedTableName}')
    WHERE name = ?
    LIMIT 1
  `).get(columnName);
  const row = rawRow == null ? undefined : ExistsFlagRowSchema.parse(rawRow);
  return Number(row?.exists_flag) === 1;
}
