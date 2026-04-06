type ParsedArgs = {
    fixtureIndex: number;
    fixtureRoot: string;
    requestTimeoutSeconds: number;
    file: string;
    question: string;
    format: 'text' | 'json';
    policyProfile: string;
    outputRoot: string;
    traceSummary: boolean;
};
type WorkItem = {
    label: string;
    sourcePath: string;
    question: string;
    format: 'text' | 'json';
    policyProfile: string;
    inputText: string;
};
type DebugOptions = {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
};
type DebugArtifactOk = {
    ok: true;
    requestId: string;
    durationMs: number;
    label: string;
    sourcePath: string;
    classification: string;
    rawReviewRequired: boolean;
    modelCallSucceeded: boolean;
    summary: string;
    summaryPreview: string;
    providerError: string | null;
};
type DebugArtifactFail = {
    ok: false;
    durationMs: number;
    label: string;
    sourcePath: string;
    error: string;
};
type DebugArtifact = DebugArtifactOk | DebugArtifactFail;
type DebugResult = {
    exitCode: number;
    artifactPath: string;
    artifact: DebugArtifact;
};
export declare function parseArgs(argv: string[]): ParsedArgs;
export declare function resolveWorkItem(args: ParsedArgs): WorkItem;
export declare function runDebugRequest(argv: string[], options?: DebugOptions): Promise<DebugResult>;
export {};
