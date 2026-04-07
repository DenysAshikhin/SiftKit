"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getUtcTimestamp = getUtcTimestamp;
exports.getLocalTimestamp = getLocalTimestamp;
exports.sleep = sleep;
exports.formatElapsed = formatElapsed;
/**
 * Returns a compact UTC timestamp string suitable for filenames:
 * `YYYYMMDD_HHMMSS_fff`.
 */
function getUtcTimestamp() {
    const current = new Date();
    const yyyy = current.getUTCFullYear();
    const MM = String(current.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(current.getUTCDate()).padStart(2, '0');
    const hh = String(current.getUTCHours()).padStart(2, '0');
    const mm = String(current.getUTCMinutes()).padStart(2, '0');
    const ss = String(current.getUTCSeconds()).padStart(2, '0');
    const fff = String(current.getUTCMilliseconds()).padStart(3, '0');
    return `${yyyy}${MM}${dd}_${hh}${mm}${ss}_${fff}`;
}
/**
 * Returns a compact local-time timestamp string suitable for filenames:
 * `YYYYMMDD_HHMMSS_fff`.
 */
function getLocalTimestamp() {
    const current = new Date();
    const yyyy = current.getFullYear();
    const MM = String(current.getMonth() + 1).padStart(2, '0');
    const dd = String(current.getDate()).padStart(2, '0');
    const hh = String(current.getHours()).padStart(2, '0');
    const mm = String(current.getMinutes()).padStart(2, '0');
    const ss = String(current.getSeconds()).padStart(2, '0');
    const fff = String(current.getMilliseconds()).padStart(3, '0');
    return `${yyyy}${MM}${dd}_${hh}${mm}${ss}_${fff}`;
}
/** Returns a promise that resolves after the given number of milliseconds. */
function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
/** Formats a duration in milliseconds as `Xm YYs` or `Ys`. */
function formatElapsed(durationMs) {
    const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes > 0
        ? `${minutes}m ${String(seconds).padStart(2, '0')}s`
        : `${seconds}s`;
}
