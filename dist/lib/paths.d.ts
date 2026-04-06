export declare function normalizeWindowsPath(value: string): string;
/**
 * Walks upward from `startPath` looking for a `package.json` whose `name` is
 * `"siftkit"`. Returns the directory that contains it, or `null` when no
 * SiftKit repo root is reachable.
 */
export declare function findNearestSiftKitRepoRoot(startPath?: string): string | null;
export declare function resolvePathFromBase(targetPath: string, baseDirectory: string): string;
export declare function resolveOptionalPathFromBase(targetPath: string | null | undefined, baseDirectory: string): string | null;
