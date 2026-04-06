import { type BenchmarkProcessResult, type ResolvedMatrixManifest, type ResolvedMatrixTarget } from './types.js';
export declare function getBenchmarkProcessPaths(sessionDirectory: string, run: ResolvedMatrixTarget): {
    stdoutPath: string;
    stderrPath: string;
    runtimeStatusPath: string;
};
export declare function invokeBenchmarkProcess(manifest: ResolvedMatrixManifest, run: ResolvedMatrixTarget, outputPath: string, sessionDirectory: string, promptPrefixFile: string | null): Promise<BenchmarkProcessResult>;
