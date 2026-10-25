/** "Do not remember this", in the phrasings a user actually types. */
export const SUPPRESSION_PATTERN =
  /\b(?:do\s*n(?:o|')t\s+remember\s+(?:this|that)|forget\s+(?:this|that)|don't\s+save\s+this)\b/i;

/**
 * Fenced code blocks and blockquote lines are somebody else's words (§7.2) and are never shown
 * to a model, so a pasted log cannot become a fact about the user or carry a prompt injection.
 */
export function stripUntrustedSpans(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*>.*$/gm, ' ')
    .trim();
}
