export type InvokeProcessResult = {
    ExitCode: number;
    StdOut: string;
    StdErr: string;
    Combined: string;
};
export declare function invokeProcess(command: string, argumentList?: string[]): InvokeProcessResult;
export declare function quoteForPowerShell(value: string): string;
export declare function captureWithTranscript(commandPath: string, argumentList: string[], transcriptPath: string): number;
