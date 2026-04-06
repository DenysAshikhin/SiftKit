#!/usr/bin/env node
interface ParsedArgs {
    fixtureIndex: number;
    fixtureStartIndex: number | null;
    fixtureEndIndex: number | null;
    outputRoot: string;
    requestTimeoutSeconds: number;
    traceSummary: boolean;
}
interface Fixture {
    Name: string;
    File: string;
    Question: string;
    Format: string;
    PolicyProfile: string;
    [key: string]: unknown;
}
interface WorkItem {
    fixtureIndex: number;
    fixture: Fixture;
    sourcePath: string;
    inputText: string;
}
interface ChunkRecord {
    index: number;
    chunkPath: string;
    inputCharacters: number;
    promptCharacters: number;
    promptTokens: number | null;
    outputCharacters: number;
    outputTokens: number | null;
    promptPath: string;
    responsePath: string;
    parsed: boolean;
    classification: string | null;
    rawReviewRequired: boolean | null;
    outputPreview: string | null;
    error: string | null;
}
interface MalformedChunkInfo {
    index: number;
    chunkPath: string;
    promptPath: string;
    responsePath: string;
    error: string;
}
interface FixtureManifest {
    ok: boolean;
    fixtureIndex: number;
    sourcePath: string;
    fixtureName: string;
    backend: string;
    model: string;
    requestTimeoutSeconds: number;
    rawReviewRequired: boolean;
    chunkThreshold: number;
    effectivePromptLimit: number;
    chunkCount: number;
    malformedChunk: MalformedChunkInfo | null;
    chunks: ChunkRecord[];
}
interface RunManifest {
    ok: boolean;
    fixtureIndex: number;
    fixtureStartIndex: number;
    fixtureEndIndex: number;
    fixtureCount: number;
    fixtureRoot: string;
    sourcePath: string;
    fixtureName: string;
    backend: string;
    model: string;
    requestTimeoutSeconds: number;
    rawReviewRequired: boolean;
    chunkThreshold: number;
    effectivePromptLimit: number;
    chunkCount: number;
    malformedChunk: MalformedChunkInfo | null;
    chunks: ChunkRecord[];
    malformedFixture: {
        fixtureIndex: number;
        fixtureName: string;
        sourcePath: string;
        chunkPath: string;
        error: string;
    } | null;
    fixtures: FixtureManifest[];
    error?: string;
    lockReleaseError?: string;
}
interface RunResult {
    exitCode: number;
    manifestPath: string;
    manifest: RunManifest;
}
interface RunOptions {
    fixtureRoot?: string;
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
}
export declare function parseArgs(argv: string[]): ParsedArgs;
export declare function resolveWorkItems(fixtureRoot: string, fixtureStartIndex: number, fixtureEndIndex: number): WorkItem[];
export declare function runFixture60MalformedJsonRepro(argv: string[], options?: RunOptions): Promise<RunResult>;
export {};
