export type DigestTool = 'node:test' | 'vitest' | 'jest' | 'pytest' | 'dotnet test' | 'go test' | 'cargo test'
  | 'tsc' | 'mypy' | 'pyright' | 'msbuild' | 'eslint';
export type DigestCount = { label: string; value: number };
/** One failing test or error diagnostic; `location` is `path:line[:col]` as the tool prints the path. */
export type DigestFailure = { name: string; location: string | null; message: string[] };
export type ToolDigest = { tool: DigestTool; counts: DigestCount[]; failed: boolean; failures: DigestFailure[] };
