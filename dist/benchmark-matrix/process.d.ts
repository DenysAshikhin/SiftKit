export declare function spawnAndWait(options: {
    filePath: string;
    args: string[];
    cwd: string;
    stdoutPath: string;
    stderrPath: string;
    env?: NodeJS.ProcessEnv;
}): Promise<{
    exitCode: number;
    pid: number;
}>;
