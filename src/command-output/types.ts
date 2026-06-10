import type { ShellName } from '../capture/process.js';
import type { SiftConfig } from '../config/index.js';
import type { SummaryClassification, SummaryPolicyProfile, SummarySourceKind } from '../summary/types.js';

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
  backend?: string;
  model?: string;
  noSummarize?: boolean;
  shell?: ShellName;
  config?: SiftConfig;
};

export type CommandOutputAnalyzeResult = {
  ExitCode: number;
  RawLogPath: string;
  ReducedLogPath: string | null;
  WasSummarized: boolean;
  PolicyDecision: string;
  Classification: SummaryClassification | 'no-summarize';
  RawReviewRequired: boolean;
  ModelCallSucceeded: boolean;
  ProviderError: string | null;
  Summary: string | null;
};

export type PresetRunRequest = {
  presetId: string;
  prompt?: string;
  question?: string;
  inputText?: string;
  format?: 'text' | 'json';
  backend?: string;
  model?: string;
  profile?: string;
  sourceKind?: SummarySourceKind;
  commandExitCode?: number;
  repoRoot?: string;
  maxTurns?: number;
  logFile?: string;
};

export type PresetRunResult = {
  outputText: string;
};

export type PresetListItem = {
  id: string;
  presetKind: string;
  operationMode: string;
  deletable: boolean;
  label: string;
};

export type PresetListResult = {
  presets: PresetListItem[];
};
