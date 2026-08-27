import { JsonObjectSchema, type JsonObject } from '../lib/json-types.js';
import { z } from '../lib/zod.js';

export const APPROVAL_VERDICTS = ['approve', 'deny', 'unsure'] as const;

export const ApprovalVerdictSchema = z.strictObject({
  verdict: z.enum(APPROVAL_VERDICTS),
  reason: z.string(),
});
export type ApprovalVerdict = z.infer<typeof ApprovalVerdictSchema>;

const APPROVAL_VERDICT_CHOICES = APPROVAL_VERDICTS.map((verdict) => JSON.stringify(verdict)).join('|');
export const APPROVAL_VERDICT_RESPONSE_INSTRUCTION =
  `{"verdict":${APPROVAL_VERDICT_CHOICES},"reason":"<one sentence>"}`;

export function buildApprovalVerdictJsonSchema(): JsonObject {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(ApprovalVerdictSchema, { io: 'input' });
  return JsonObjectSchema.parse(schema);
}
