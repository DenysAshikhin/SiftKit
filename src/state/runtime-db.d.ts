import Database from 'better-sqlite3';
export type RuntimeDatabase = InstanceType<typeof Database>;
export declare const CURRENT_SCHEMA_VERSION = 29;
export declare function getRepoRuntimeRoot(startPath?: string): string;
export declare function getRuntimeDatabasePath(startPath?: string): string;
export declare function getRuntimeDatabase(databasePath?: string): RuntimeDatabase;
export declare function closeRuntimeDatabase(): void;
export declare function getRuntimeMetadataValue(key: string, databasePath?: string): string | null;
export interface PruneRuntimeHistoryResult {
    retentionDays: number;
    cutoffUtc: string;
    deleted: {
        table: string;
        rows: number;
    }[];
    vacuumed: boolean;
}
export declare function pruneRuntimeHistory(retentionDays: number, databasePath?: string): PruneRuntimeHistoryResult;
export declare function setRuntimeMetadataValue(key: string, value: string, databasePath?: string): void;
