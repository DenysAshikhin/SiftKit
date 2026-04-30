import { randomUUID } from 'node:crypto';
import { getConfiguredModel, initializeRuntime, loadConfig } from './config/index.js';
import { summarizeRequest } from './summary/core.js';
import { getDeterministicExcerpt } from './summary/measure.js';
import { getSummaryDecision } from './summary/decision.js';
import type { SummaryClassification } from './summary/types.js';
import { withExecutionLock } from './execution-lock.js';
import { invokeProcess, invokeShellProcess, type ShellName } from './capture/process.js';
import { upsertRuntimeTextArtifact } from './state/runtime-artifacts.js';

export type CommandRequest = {
  Command: string;
  ArgumentList?: string[];
  Question?: string;
  RiskLevel?: 'informational' | 'debug' | 'risky';
  ReducerProfile?: 'smart' | 'errors' | 'tail' | 'diff' | 'none';
  Format?: 'text' | 'json';
  PolicyProfile?: 'general' | 'pass-fail' | 'unique-errors' | 'buried-critical' | 'json-extraction' | 'diff-summary' | 'risky-operation';
  Backend?: string;
  Model?: string;
  NoSummarize?: boolean;
  Shell?: ShellName;
};

export type CommandResult = {
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

export type CommandAnalysisRequest = {
  ExitCode: number;
  CombinedText: string;
  CommandText?: string;
  Question?: string;
  RiskLevel?: 'informational' | 'debug' | 'risky';
  ReducerProfile?: 'smart' | 'errors' | 'tail' | 'diff' | 'none';
  Format?: 'text' | 'json';
  PolicyProfile?: 'general' | 'pass-fail' | 'unique-errors' | 'buried-critical' | 'json-extraction' | 'diff-summary' | 'risky-operation';
  Backend?: string;
  Model?: string;
  NoSummarize?: boolean;
};

function compressRepeatedLines(lines: string[]): string[] {
  if (lines.length === 0) {
    return [];
  }

  const result: string[] = [];
  let current = lines[0];
  let count = 1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === current) {
      count += 1;
      continue;
    }

    if (count > 3) {
      result.push(`${current} [repeated ${count} times]`);
    } else {
      for (let repeat = 0; repeat < count; repeat += 1) {
        result.push(current);
      }
    }

    current = lines[index];
    count = 1;
  }

  if (count > 3) {
    result.push(`${current} [repeated ${count} times]`);
  } else {
    for (let repeat = 0; repeat < count; repeat += 1) {
      result.push(current);
    }
  }

  return result;
}

function getErrorContextLines(lines: string[]): string[] {
  const pattern = /(error|exception|failed|fatal|denied|timeout|traceback|panic|duplicate key|destroy)/iu;
  const indexes = lines.reduce<number[]>((result, line, index) => {
    if (pattern.test(line)) {
      result.push(index);
    }
    return result;
  }, []);

  if (indexes.length === 0) {
    return [];
  }

  const selected: string[] = [];
  const seen = new Set<number>();
  for (const index of indexes) {
    const start = Math.max(index - 2, 0);
    const end = Math.min(index + 2, lines.length - 1);
    for (let cursor = start; cursor <= end; cursor += 1) {
      if (!seen.has(cursor)) {
        seen.add(cursor);
        selected.push(lines[cursor]);
      }
    }
  }

  return selected;
}

function reduceText(text: string, reducerProfile: CommandRequest['ReducerProfile']): string {
  if (reducerProfile === 'none') {
    return text;
  }

  const lines = text.length > 0 ? text.replace(/\r\n/gu, '\n').split('\n') : [];
  if (lines.length <= 200) {
    return text;
  }

  const compressed = compressRepeatedLines(lines);
  switch (reducerProfile) {
    case 'errors': {
      const context = getErrorContextLines(compressed);
      return context.length > 0 ? context.join('\n') : compressed.slice(-120).join('\n');
    }
    case 'tail':
      return compressed.slice(-160).join('\n');
    case 'diff': {
      const diffLines = compressed.filter((line) => /^(diff --git|\+\+\+|---|@@|\+[^+]|-[^-]|index\s|rename |new file mode|deleted file mode)/u.test(line));
      return diffLines.length > 0 ? diffLines.join('\n') : compressed.slice(0, 80).join('\n');
    }
    default: {
      const context = getErrorContextLines(compressed);
      if (context.length > 0) {
        return [...compressed.slice(0, 20), '', ...context, '', ...compressed.slice(-40)].join('\n');
      }
      return [...compressed.slice(0, 40), '', ...compressed.slice(-80)].join('\n');
    }
  }
}

export async function analyzeCommandOutput(request: CommandAnalysisRequest): Promise<CommandResult> {
  const config = await loadConfig({ ensure: true });
  const backend = request.Backend || config.Backend;
  const model = request.Model || getConfiguredModel(config);
  void initializeRuntime();
  const combinedText = request.CombinedText || '';
  const rawLogId = randomUUID();
  const rawLogPath = upsertRuntimeTextArtifact({
    id: rawLogId,
    artifactKind: 'command_raw',
    content: combinedText,
  }).uri;

  const question = request.Question || 'Summarize the main result and any actionable failures.';
  const riskLevel = request.RiskLevel || 'informational';
  const reducerProfile = request.ReducerProfile || 'smart';
  const format = request.Format || 'text';
  const policyProfile = request.PolicyProfile || 'general';
  const decision = getSummaryDecision(combinedText, question, riskLevel, config, {
    sourceKind: 'command-output',
    commandExitCode: request.ExitCode,
  });
  const reducedText = reduceText(combinedText, reducerProfile);
  const deterministicExcerpt = getDeterministicExcerpt(combinedText, question);

  let reducedLogPath: string | null = null;
  if (reducedText !== combinedText) {
    reducedLogPath = upsertRuntimeTextArtifact({
      id: randomUUID(),
      artifactKind: 'command_reduced',
      content: reducedText,
    }).uri;
  }

  if (request.NoSummarize || !decision.ShouldSummarize) {
    return {
      ExitCode: request.ExitCode,
      RawLogPath: rawLogPath,
      ReducedLogPath: reducedLogPath,
      WasSummarized: false,
      PolicyDecision: request.NoSummarize ? 'no-summarize' : decision.Reason,
      Classification: 'no-summarize',
      RawReviewRequired: decision.RawReviewRequired,
      ModelCallSucceeded: false,
      ProviderError: null,
      Summary: deterministicExcerpt ? `Raw review required.\nRaw log: ${rawLogPath}\n${deterministicExcerpt}` : null,
    };
  }

  const effectiveProfile = ((riskLevel === 'debug' || riskLevel === 'risky') && policyProfile === 'general')
    ? 'risky-operation'
    : policyProfile;
  const summaryResult = await summarizeRequest({
    question,
    inputText: combinedText,
    format,
    policyProfile: effectiveProfile,
    backend,
    model,
    sourceKind: 'command-output',
    commandExitCode: request.ExitCode,
    debugCommand: request.CommandText,
  });
  const summaryText = summaryResult.RawReviewRequired && summaryResult.Classification !== 'unsupported_input' && summaryResult.Summary.trim()
    ? `${summaryResult.Summary.trim()}\nRaw log: ${rawLogPath}`
    : summaryResult.Summary;

  return {
    ExitCode: request.ExitCode,
    RawLogPath: rawLogPath,
    ReducedLogPath: reducedLogPath,
    WasSummarized: summaryResult.WasSummarized,
    PolicyDecision: summaryResult.PolicyDecision,
    Classification: summaryResult.Classification,
    RawReviewRequired: summaryResult.RawReviewRequired,
    ModelCallSucceeded: summaryResult.ModelCallSucceeded,
    ProviderError: summaryResult.ProviderError,
    Summary: summaryText,
  };
}

export async function runCommand(request: CommandRequest): Promise<CommandResult> {
  return withExecutionLock(async () => {
    const processResult = request.Shell
      ? invokeShellProcess(request.Command, request.Shell)
      : invokeProcess(request.Command, request.ArgumentList || []);
    const commandText = request.Shell
      ? `[${request.Shell}] ${request.Command}`
      : [request.Command, ...(request.ArgumentList || [])].join(' ');
    return analyzeCommandOutput({
      ExitCode: processResult.ExitCode,
      CombinedText: processResult.Combined,
      CommandText: commandText,
      Question: request.Question,
      RiskLevel: request.RiskLevel,
      ReducerProfile: request.ReducerProfile,
      Format: request.Format,
      PolicyProfile: request.PolicyProfile,
      Backend: request.Backend,
      Model: request.Model,
      NoSummarize: request.NoSummarize,
    });
  });
}
