"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertHttpUrl = assertHttpUrl;
exports.assertPublicHttpUrl = assertPublicHttpUrl;
const PRIVATE_HOST_SUFFIXES = ['.local', '.internal'];
function isPrivateIpv4(hostname) {
    const parts = hostname.split('.').map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
        return false;
    }
    const [a, b] = parts;
    return a === 10
        || a === 127
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168)
        || (a === 169 && b === 254);
}
function isBlockedHostname(hostname) {
    const normalized = hostname.trim().toLowerCase();
    if (!normalized || normalized === 'localhost') {
        return true;
    }
    if (normalized === '::1' || normalized.startsWith('[')) {
        return true;
    }
    if (isPrivateIpv4(normalized)) {
        return true;
    }
    return PRIVATE_HOST_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}
function assertHttpUrl(value) {
    let url;
    try {
        url = new URL(String(value || '').trim());
    }
    catch {
        throw new Error('Expected a valid URL.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Expected an http or https URL.');
    }
    return url;
}
function assertPublicHttpUrl(value) {
    const url = assertHttpUrl(value);
    if (isBlockedHostname(url.hostname)) {
        throw new Error('Blocked private, internal, or local URL host.');
    }
    return url;
}
