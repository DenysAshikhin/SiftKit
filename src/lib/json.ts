export function parseJsonText<T>(text: string): T {
  const normalized = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  return JSON.parse(normalized) as T;
}
