/**
 * Returns a compact UTC timestamp string suitable for filenames:
 * `YYYYMMDD_HHMMSS_fff`.
 */
export declare function getUtcTimestamp(): string;
/**
 * Returns a compact local-time timestamp string suitable for filenames:
 * `YYYYMMDD_HHMMSS_fff`.
 */
export declare function getLocalTimestamp(): string;
/** Returns a promise that resolves after the given number of milliseconds. */
export declare function sleep(milliseconds: number): Promise<void>;
/** Formats a duration in milliseconds as `Xm YYs` or `Ys`. */
export declare function formatElapsed(durationMs: number): string;
