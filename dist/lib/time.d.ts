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
/** Formats a duration in milliseconds as `Xm YYs` or `Ys`. */
export declare function formatElapsed(durationMs: number): string;
