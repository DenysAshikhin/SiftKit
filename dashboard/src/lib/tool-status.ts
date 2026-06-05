function extractFetchHost(command: string): string | null {
  const match = /url="([^"]+)"/u.exec(command);
  const url = match?.[1];
  if (!url) {
    return null;
  }
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function getToolRunningLabel(command: string): string {
  const trimmed = command.trim();
  if (trimmed.startsWith('web_search')) {
    return 'Fetching search results…';
  }
  if (trimmed.startsWith('web_fetch')) {
    const host = extractFetchHost(trimmed);
    return host ? `Loading ${host}…` : 'Loading page…';
  }
  return '…';
}
