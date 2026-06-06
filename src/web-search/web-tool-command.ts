export type RetainedWebToolCall = {
  toolName: 'web_search' | 'web_fetch';
  value: string;
  command: string;
  exitCode: number | null;
  output: string;
};

function quoteWebToolValue(value: string): string {
  return JSON.stringify(String(value || ''));
}

function parseJsonStringValue(rawValue: string): string | null {
  try {
    const parsed = JSON.parse(rawValue);
    const value = typeof parsed === 'string' ? parsed.trim() : '';
    return value ? value : null;
  } catch {
    return null;
  }
}

export function formatWebSearchCommand(query: string): string {
  return `web_search query=${quoteWebToolValue(query)}`;
}

export function formatWebFetchCommand(url: string): string {
  return `web_fetch url=${quoteWebToolValue(url)}`;
}

export function parseWebToolCommand(command: string): RetainedWebToolCall | null {
  const text = String(command || '').trim();
  if (text.startsWith('web_search query=')) {
    const value = parseJsonStringValue(text.slice('web_search query='.length));
    return value ? { toolName: 'web_search', value, command: text, exitCode: null, output: '' } : null;
  }
  if (text.startsWith('web_fetch url=')) {
    const value = parseJsonStringValue(text.slice('web_fetch url='.length));
    return value ? { toolName: 'web_fetch', value, command: text, exitCode: null, output: '' } : null;
  }
  return null;
}
