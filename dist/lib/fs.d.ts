export declare function ensureDirectory(dirPath: string): string;
export declare function writeUtf8NoBom(filePath: string, content: string): void;
export declare function isRetryableFsError(error: unknown): boolean;
export declare function saveContentAtomically(filePath: string, content: string): void;
export declare function readJsonFile<T>(filePath: string): T;
export declare function writeJsonFile(filePath: string, value: unknown): void;
export declare function readTextIfExists(targetPath: string): string | null;
export declare function readTrimmedFileText(filePath: string): string;
export declare function listFiles(targetPath: string): string[];
