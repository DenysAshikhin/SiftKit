import { CommandOutputAnalyzer } from '../../src/command-output/analyzer.js';
import { invokeProcess, invokeShellProcess } from '../../src/capture/process.js';
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
  Backend?: CommandOutputAnalyzeRequest['backend'];
  Model?: CommandOutputAnalyzeRequest['model'];
  NoSummarize?: boolean;
}

export async function runCommand(request: RunCommandRequest): Promise<CommandOutputAnalyzeResult> {
  const command = String(request.Command || '');
  const argumentList = Array.isArray(request.ArgumentList) ? request.ArgumentList.map(String) : [];
  const shell = request.Shell;
  const processResult = shell
    ? invokeShellProcess(command, shell)
    : invokeProcess(command, argumentList);
  return new CommandOutputAnalyzer().analyze({
    outputKind: 'command',
    exitCode: processResult.ExitCode,
    combinedText: processResult.Combined,
    commandText: shell ? `[${shell}] ${command}` : [command, ...argumentList].join(' '),
    question: request.Question,
    riskLevel: request.RiskLevel,
    reducerProfile: request.ReducerProfile,
    format: request.Format,
    policyProfile: request.PolicyProfile,
    backend: request.Backend,
    model: request.Model,
    noSummarize: request.NoSummarize,
    shell,
  });
}
