export function estimatePromptTokens(content: string): number {
  return Math.max(1, Math.ceil(content.length / 4));
}
