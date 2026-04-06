type ImportOptions = {
    suiteFile: string;
    outputDir: string;
    repoRoot?: string;
};
export declare function importMarkdownBenchmark(options: ImportOptions): {
    SuiteFile: string;
    RepoRoot: string;
    OutputDir: string;
    FixtureCount: number;
};
export {};
