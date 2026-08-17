/**
 * Chat-template reasoning markers (Qwen/GLM convention). Single owner for
 * inline-think extraction and the thinking-budget continuation prefix.
 */
export const THINK_OPEN_TAG = '<think>';
export const THINK_CLOSE_TAG = '</think>';

/** A completed reasoning block the model will not reopen: used as a response prefix. */
export function buildClosedThinkBlock(thinkingText: string): string {
  return `${THINK_OPEN_TAG}\n${thinkingText}\n${THINK_CLOSE_TAG}\n\n`;
}

/** Fresh per call: the `g` flag makes the RegExp stateful, so it must not be shared. */
export function buildInlineThinkPattern(): RegExp {
  return new RegExp(`${THINK_OPEN_TAG}([\\s\\S]*?)${THINK_CLOSE_TAG}`, 'gu');
}
