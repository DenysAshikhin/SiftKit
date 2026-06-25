import { z } from './lib/zod.js';
import { SummaryClassificationSchema } from './summary/types.js';

export type EvalRequest = {
  FixtureRoot?: string;
  RealLogPath?: string[];
  Backend?: string;
  Model?: string;
};

export const EvalCaseResultSchema = z.object({
  Name: z.string(),
  SourcePath: z.string(),
  WasSummarized: z.boolean(),
  PolicyDecision: z.string(),
  Classification: SummaryClassificationSchema,
  RawReviewRequired: z.boolean(),
  ModelCallSucceeded: z.boolean(),
  Summary: z.string(),
  Recall: z.number().nullable(),
  Precision: z.number().nullable(),
  Faithfulness: z.number().nullable(),
  Format: z.number().nullable(),
  Compression: z.number().nullable(),
  Total: z.number().nullable(),
  Notes: z.string(),
});
export type EvalCaseResult = z.infer<typeof EvalCaseResultSchema>;

export const EvaluationResultSchema = z.object({
  Backend: z.string(),
  Model: z.string(),
  ResultPath: z.string(),
  Results: z.array(EvalCaseResultSchema),
});
export type EvaluationResult = z.infer<typeof EvaluationResultSchema>;
