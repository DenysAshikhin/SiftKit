import type { SummaryClassification } from './summary/types.js';

export type EvalRequest = {
  FixtureRoot?: string;
  RealLogPath?: string[];
  Backend?: string;
  Model?: string;
};

export type EvalCaseResult = {
  Name: string;
  SourcePath: string;
  WasSummarized: boolean;
  PolicyDecision: string;
  Classification: SummaryClassification;
  RawReviewRequired: boolean;
  ModelCallSucceeded: boolean;
  Summary: string;
  Recall: number | null;
  Precision: number | null;
  Faithfulness: number | null;
  Format: number | null;
  Compression: number | null;
  Total: number | null;
  Notes: string;
};

export type EvaluationResult = {
  Backend: string;
  Model: string;
  ResultPath: string;
  Results: EvalCaseResult[];
};
