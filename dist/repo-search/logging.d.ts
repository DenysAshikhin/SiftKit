import type { JsonLogger } from './types.js';
export declare function traceRepoSearch(message: string): void;
export declare function ensureRepoSearchLogFolders(): {
    root: string;
    successful: string;
    failed: string;
};
export declare function moveFileSafe(sourcePath: string, targetPath: string): void;
export declare function createJsonLogger(logPath: string): JsonLogger;
