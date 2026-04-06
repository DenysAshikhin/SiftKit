export declare function getRepoSearchServiceUrl(): string;
export declare function runRepoSearchCli(options: {
    argv: string[];
    stdout: NodeJS.WritableStream;
}): Promise<number>;
