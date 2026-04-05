"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.roundDuration = roundDuration;
exports.buildBenchmarkArtifact = buildBenchmarkArtifact;
function roundDuration(durationMs) {
    return Math.round(durationMs * 1000) / 1000;
}
function buildBenchmarkArtifact(options) {
    const completedAt = new Date();
    const totalDurationMs = Number(process.hrtime.bigint() - options.startedAtHr) / 1_000_000;
    return {
        Status: options.status,
        TotalDurationMs: roundDuration(totalDurationMs),
        StartedAtUtc: options.startedAt.toISOString(),
        CompletedAtUtc: completedAt.toISOString(),
        Backend: options.backend,
        Model: options.model,
        FixtureRoot: options.fixtureRoot,
        OutputPath: options.outputPath,
        PromptPrefix: options.promptPrefix ?? null,
        CompletedFixtureCount: options.results.length,
        FatalError: options.fatalError,
        Results: options.results,
    };
}
