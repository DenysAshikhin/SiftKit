// Type declarations for the CommonJS test helper run-command-for-test.cjs.
import type { CommandOutputAnalyzeRequest, CommandOutputAnalyzeResult } from '../../src/command-output/types.js';
import type { ShellName } from '../../src/capture/process.js';

export interface RunCommandRequest {
  Command?: string;
  ArgumentList?: string[];
  Shell?: ShellName;
  Question?: CommandOutputAnalyzeRequest['question'];
  RiskLevel?: CommandOutputAnalyzeRequest['riskLevel'];
  ReducerProfile?: CommandOutputAnalyzeRequest['reducerProfile'];
  Format?: CommandOutputAnalyzeRequest['format'];
  PolicyProfile?: CommandOutputAnalyzeRequest['policyProfile'];
  Backend?: string;
  Model?: string;
  NoSummarize?: boolean;
}

export function runCommand(request: RunCommandRequest): Promise<CommandOutputAnalyzeResult>;
