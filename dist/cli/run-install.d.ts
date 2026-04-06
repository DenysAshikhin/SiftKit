export declare function runInstall(stdout: NodeJS.WritableStream): Promise<number>;
export declare function runCodexPolicyCli(options: {
    argv: string[];
    stdout: NodeJS.WritableStream;
}): Promise<number>;
export declare function runInstallGlobalCli(options: {
    argv: string[];
    stdout: NodeJS.WritableStream;
}): Promise<number>;
