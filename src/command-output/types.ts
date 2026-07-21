import { z } from '../lib/zod.js';
import type { ShellName } from '../capture/process.js';
import type { SiftConfig } from '../config/index.js';
import {
  SummaryClassificationSchema,
  type SummaryPolicyProfile,
  type SummaryProviderId,
  type SummarySourceKind,
} from '../summary/types.js';

export type CommandOutputKind = 'command' | 'interactive';

export type CommandOutputRiskLevel = 'informational' | 'debug' | 'risky';

export type CommandOutputReducerProfile = 'smart' | 'errors' | 'tail' | 'diff' | 'none';

export type CommandOutputAnalyzeRequest = {
  outputKind: CommandOutputKind;
  exitCode: number;
  combinedText: string;
  commandText?: string;
  question?: string;
  riskLevel?: CommandOutputRiskLevel;
  reducerProfile?: CommandOutputReducerProfile;
  format?: 'text' | 'json';
  policyProfile?: SummaryPolicyProfile;
  backend?: SummaryProviderId;
  model?: string;
  noSummarize?: boolean;
  shell?: ShellName;
  config?: SiftConfig;
};

export const CommandOutputAnalyzeResultSchema = z.object({
  ExitCode: z.number(),
  RawLogPath: z.string(),
  ReducedLogPath: z.string().nullable(),
  WasSummarized: z.boolean(),
  PolicyDecision: z.string(),
  Classification: z.union([SummaryClassificationSchema, z.literal('no-summarize')]),
  RawReviewRequired: z.boolean(),
  ModelCallSucceeded: z.boolean(),
  ProviderError: z.string().nullable(),
  Summary: z.string().nullable(),
});
export type CommandOutputAnalyzeResult = z.infer<typeof CommandOutputAnalyzeResultSchema>;

export type PresetRunRequest = {
  presetId: string;
  prompt?: string;
  question?: string;
  inputText?: string;
  format?: 'text' | 'json';
  backend?: SummaryProviderId;
  model?: string;
  profile?: string;
  sourceKind?: SummarySourceKind;
  commandExitCode?: number;
  repoRoot?: string;
  maxTurns?: number;
  logFile?: string;
};

export const PresetRunResultSchema = z.object({
  outputText: z.string(),
});
export type PresetRunResult = z.infer<typeof PresetRunResultSchema>;

export const PresetListItemSchema = z.object({
  id: z.string(),
  presetKind: z.string(),
  operationMode: z.string(),
  deletable: z.boolean(),
  label: z.string(),
});
export type PresetListItem = z.infer<typeof PresetListItemSchema>;

export const PresetListResultSchema = z.object({
  presets: z.array(PresetListItemSchema),
});
export type PresetListResult = z.infer<typeof PresetListResultSchema>;
