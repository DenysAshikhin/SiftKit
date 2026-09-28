import { z } from 'zod';

/** Content that cannot wrap at a word boundary, shared by the overflow page and the run the test serves it. */
export const UNBROKEN = 'unbreakable'.repeat(40);
export const HOSTILE_PATH = 'segment/'.repeat(40);

/** Messages short enough that their bubbles must hug their content. */
export const SHORT_QUESTION = 'Short question?';
export const SHORT_ANSWER = 'Short answer.';

/** What the page must have rendered, so a clean measurement cannot come from an empty page. */
export const OVERFLOW_PRESENT = ['.question-card', '.approval-reject-form', '.orchestrator-run', '.err-banner', '.warning-banner',
  '.markdown-body table', '.approval-row', '.msgs-chunk', 'details[open]'];

export const OverflowReportSchema = z.strictObject({
  present: z.array(z.string()),
  scenarios: z.array(z.strictObject({
    name: z.string(), sideways: z.array(z.number()), escapes: z.array(z.string()), misaligned: z.array(z.string()), estimateErrors: z.array(z.string()),
  })),
});
export type OverflowReport = z.infer<typeof OverflowReportSchema>;
