import { type BenchmarkFixture, type BenchmarkRunnerOptions } from './types.js';
export declare function getRepoRoot(): string;
export declare function parseArguments(argv: string[]): BenchmarkRunnerOptions;
export declare function resolvePromptPrefix(options: BenchmarkRunnerOptions): string | undefined;
export declare function getValidatedRequestTimeoutSeconds(options: BenchmarkRunnerOptions): number;
export declare function getDefaultOutputPath(fixtureRoot?: string): string;
export declare function getPromptLabel(options: {
    fixture: BenchmarkFixture;
}): string;
