import { copyText } from '../lib/bounded-output.ts';
import { cutDigest, digestOutput } from './digest.ts';

export type KeptOutput = { output: string; digest: string | null };

/** What is kept of a command's output: its tail, and a digest of all of it. Neither keeps the whole text alive. */
export function keepOutput(output: string, limits: { tailChars: number; digestChars: number }): KeptOutput {
  const digest = digestOutput(output);
  return {
    output: copyText(output.slice(-limits.tailChars)),
    digest: digest === null ? null : copyText(cutDigest(digest.text, limits.digestChars)),
  };
}
