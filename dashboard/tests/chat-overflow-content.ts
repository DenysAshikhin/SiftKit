import { z } from 'zod';

/** Content that cannot wrap at a word boundary, shared by the overflow page and the run the test serves it. */
export const UNBROKEN = 'unbreakable'.repeat(40);
export const HOSTILE_PATH = 'segment/'.repeat(40);

/** What the page must have rendered, so a clean measurement cannot come from an empty page. */
export const OVERFLOW_PRESENT = ['.question-card', '.approval-reject-form', '.orchestrator-run', '.err-banner', '.warning-banner', '.markdown-body table', '.approval-row', 'details[open]'];

const OverflowReportSchema = z.strictObject({
  present: z.array(z.string()),
  scenarios: z.array(z.strictObject({ name: z.string(), sideways: z.array(z.number()), escapes: z.array(z.string()) })),
});
export type OverflowReport = z.infer<typeof OverflowReportSchema>;
export const OverflowResultSchema = z.union([z.strictObject({ report: OverflowReportSchema }), z.strictObject({ error: z.string() })]);
