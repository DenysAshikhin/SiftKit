import { z } from 'zod';

/** One streamed turn: thinking, then a markdown answer with paragraphs and a fenced code block. */
export const LOAD_TOKENS_PER_SECOND = 100;
export const LOAD_THINKING_TOKENS = 300;
export const LOAD_ANSWER_TOKENS = 700;
export const LOAD_SUBMISSION_ID = '4f9c1f9a-0000-4000-8000-0000000000c1';

const WORDS = ['the', 'stream', 'renders', 'each', 'token', 'into', 'a', 'growing', 'answer', 'while', 'history', 'stays', 'still'];
const CODE_START = 200;
const CODE_END = 260;

/** The text of answer or thinking token `index`, about one word; the answer carries one code block. */
export function loadTokenText(kind: 'thinking' | 'answer', index: number): string {
  if (kind === 'answer' && index === CODE_START) return '\n\n```ts\n';
  if (kind === 'answer' && index === CODE_END) return '```\n\n';
  if (kind === 'answer' && index > CODE_START && index < CODE_END) return `const value${String(index)} = ${String(index)};\n`;
  const word = WORDS[index % WORDS.length] ?? 'token';
  return index % 37 === 36 ? `${word}.\n\n` : `${word} `;
}

export const StreamLoadResultSchema = z.strictObject({
  snapshots: z.number(), answerChars: z.number(), lastWordRendered: z.boolean(),
  wallMs: z.number(), frames: z.number(), longTasks: z.number(), longTaskMs: z.number(),
});
export type StreamLoadResult = z.infer<typeof StreamLoadResultSchema>;
