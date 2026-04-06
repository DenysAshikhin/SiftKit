export type BenchmarkSampling = {
    temperature: number;
    topP: number;
    topK: number;
    minP: number;
    presencePenalty: number;
    repetitionPenalty: number;
};
export type RawMatrixManifest = {
    fixtureRoot: string;
    configUrl: string;
    promptPrefixFile?: string | null;
    requestTimeoutSeconds?: number | null;
    startScript: string;
    stopScript?: string | null;
    resultsRoot: string;
    baseline: {
        modelId: string;
        modelPath: string;
        contextSize: number;
        maxTokens: number;
        reasoning: string;
        passReasoningArg?: boolean;
    };
    runs: Array<{
        index: number;
        id: string;
        label: string;
        enabled: boolean;
        modelId: string;
        modelPath: string;
        startScript?: string | null;
        promptPrefixFile?: string | null;
        contextSize?: number;
        maxTokens?: number;
        passReasoningArg?: boolean;
        reasoning?: 'on' | 'off' | 'auto';
        sampling: {
            temperature: number;
            topP: number;
            topK: number;
            minP: number;
            presencePenalty: number;
            repetitionPenalty: number;
        };
    }>;
};
export type ResolvedMatrixTarget = {
    index: number;
    id: string;
    label: string;
    modelId: string;
    modelPath: string;
    startScript: string;
    resolvedModelPath: string;
    promptPrefixFile: string | null;
    reasoning: 'on' | 'off' | 'auto';
    sampling: BenchmarkSampling | null;
    contextSize: number;
    maxTokens: number;
    passReasoningArg: boolean;
};
export type ResolvedMatrixManifest = {
    manifestPath: string;
    manifestDirectory: string;
    fixtureRoot: string;
    configUrl: string;
    promptPrefixFile: string | null;
    requestTimeoutSeconds: number;
    startScript: string;
    stopScript: string | null;
    resultsRoot: string;
    baseline: ResolvedMatrixTarget;
    enabledRuns: ResolvedMatrixTarget[];
    selectedRuns: ResolvedMatrixTarget[];
};
export type MatrixCliOptions = {
    manifestPath: string;
    runIds: string[];
    promptPrefixFile: string | null;
    requestTimeoutSeconds: number | null;
    validateOnly: boolean;
};
export type RunEntry = {
    index: number;
    id: string;
    label: string;
    modelId: string;
    modelPath: string;
    startScript: string;
    promptPrefixFile: string | null;
    reasoning: 'on' | 'off' | 'auto';
    sampling: BenchmarkSampling | null;
    outputPath: string;
    benchmarkStdoutPath: string | null;
    benchmarkStderrPath: string | null;
    startedAtUtc: string;
    completedAtUtc: string | null;
    status: 'running' | 'completed' | 'failed';
    error: string | null;
};
export type MatrixIndex = {
    manifestPath: string;
    resolvedManifestPath: string;
    fixtureRoot: string;
    resultsRoot: string;
    sessionDirectory: string;
    configUrl: string;
    promptPrefixFile: string | null;
    selectedRunIds: string[];
    startedAtUtc: string;
    completedAtUtc: string | null;
    status: 'running' | 'completed' | 'failed';
    configSnapshotPath: string;
    baselineRestore: {
        status: 'pending' | 'completed' | 'failed';
        error: string | null;
    };
    runs: RunEntry[];
};
export type ConfigRecord = Record<string, unknown> & {
    Backend?: string;
    Model?: string;
    LlamaCpp?: Record<string, unknown>;
};
export type LaunchResult = {
    hostProcessId: number;
    stdoutPath: string;
    stderrPath: string;
};
export type BenchmarkProcessResult = {
    stdoutPath: string;
    stderrPath: string;
    exitCode: number;
};
export declare class MatrixInterruptedError extends Error {
    constructor(signal: NodeJS.Signals);
}
export declare const repoRoot: string;
export declare const defaultManifestPath: string;
export declare const powerShellExe = "powershell.exe";
export declare const nodeExe: string;
export declare const ONE_WEEK_MS: number;
