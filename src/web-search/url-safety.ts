const PRIVATE_HOST_SUFFIXES = ['.local', '.internal'] as const;

function isPrivateIpv4(hostname: string): boolean {
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

function isBlockedHostname(hostname: string): boolean {
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

export function assertHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new Error('Expected a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Expected an http or https URL.');
  }
  return url;
}

export function assertPublicHttpUrl(value: string): URL {
  const url = assertHttpUrl(value);
  if (isBlockedHostname(url.hostname)) {
    throw new Error('Blocked private, internal, or local URL host.');
  }
  return url;
}
