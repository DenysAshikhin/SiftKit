export type ColorOptions = {
    env?: NodeJS.ProcessEnv;
    isTTY?: boolean;
};
export declare function formatTimestamp(date?: Date): string;
export declare function formatElapsed(milliseconds: number): string;
export declare function formatGroupedNumber(value: unknown, fractionDigits?: number | null): string;
export declare function formatInteger(value: unknown): string;
export declare function formatMilliseconds(milliseconds: unknown): string;
export declare function formatSeconds(milliseconds: unknown): string;
export declare function formatPercentage(value: unknown): string;
export declare function formatRatio(value: unknown): string;
export declare function formatTokensPerSecond(value: unknown): string;
export declare function supportsAnsiColor(options?: ColorOptions): boolean;
export declare function colorize(text: string, colorCode: number, options?: ColorOptions): string;
