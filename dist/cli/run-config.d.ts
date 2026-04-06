export declare function runConfigGet(stdout: NodeJS.WritableStream): Promise<number>;
export declare function runConfigSet(options: {
    argv: string[];
    stdout: NodeJS.WritableStream;
}): Promise<number>;
