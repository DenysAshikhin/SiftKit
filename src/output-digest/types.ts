/** Every tool a parser recognises, in the order `digestToolOutput` runs them. */
export const DIGEST_TOOLS = ['node:test', 'vitest', 'jest', 'pytest', 'dotnet test', 'go test', 'cargo test',
  'tsc', 'mypy', 'pyright', 'msbuild', 'eslint'] as const;
export type DigestTool = (typeof DIGEST_TOOLS)[number];
/** The prompt rule every agent that runs checks gets: a trimmed or filtered output starves the digest. */
export const UNFILTERED_CHECK_OUTPUT_RULE = 'Run test, build, lint, and typecheck commands unfiltered: no `Select-Object -Last`, `Get-Content -Tail`, `Select-String`, or redirection. The digest is built from the whole output, and the final lines are kept after it.';
export type DigestCount = { label: string; value: number };
/** One failing test or error diagnostic; `location` is `path:line[:col]` as the tool prints the path. */
export type DigestFailure = { name: string; location: string | null; message: string[] };
export type ToolDigest = { tool: DigestTool; counts: DigestCount[]; failed: boolean; failures: DigestFailure[] };
