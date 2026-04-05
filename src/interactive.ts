import * as fs from 'node:fs';
import { getConfiguredModel, initializeRuntime, loadConfig, saveContentAtomically } from './config.js';
import { summarizeRequest } from './summary.js';
import { newArtifactPath } from './capture/artifacts.js';
import { resolveExternalCommand } from './capture/command-path.js';
import { captureWithTranscript } from './capture/process.js';

export type InteractiveCaptureRequest = {
  Command: string;
  ArgumentList?: string[];
  Question?: string;
  Format?: 'text' | 'json';
  Backend?: string;
  Model?: string;
  PolicyProfile?: 'general' | 'pass-fail' | 'unique-errors' | 'buried-critical' | 'json-extraction' | 'diff-summary' | 'risky-operation';
};

export async function runInteractiveCapture(request: InteractiveCaptureRequest): Promise<Record<string, unknown>> {
  const config = await loadConfig({ ensure: true });
  const backend = request.Backend || config.Backend;
  const model = request.Model || getConfiguredModel(config);
  const format = request.Format || 'text';
  const policyProfile = request.PolicyProfile || 'general';
  const question = request.Question || 'Summarize the important result and any actionable failures.';

  const paths = initializeRuntime();
  const transcriptPath = newArtifactPath(paths.Logs, 'interactive_raw', 'log');
  const resolvedCommand = resolveExternalCommand(request.Command);
  let exitCode = 0;

  try {
    exitCode = captureWithTranscript(resolvedCommand, request.ArgumentList || [], transcriptPath);
  } catch {
    saveContentAtomically(transcriptPath, '');
    exitCode = 1;
  }

  let transcriptText = fs.existsSync(transcriptPath) ? fs.readFileSync(transcriptPath, 'utf8') : '';
  if (config.Interactive.MaxTranscriptCharacters && transcriptText.length > Number(config.Interactive.MaxTranscriptCharacters)) {
    transcriptText = transcriptText.substring(transcriptText.length - Number(config.Interactive.MaxTranscriptCharacters));
    saveContentAtomically(transcriptPath, transcriptText);
  }

  if (!transcriptText.trim()) {
    transcriptText = `Interactive command completed without a captured transcript.\nCommand: ${request.Command} ${(request.ArgumentList || []).join(' ')}\nExitCode: ${exitCode}`;
    saveContentAtomically(transcriptPath, transcriptText);
  }

  const summaryResult = await summarizeRequest({
    question,
    inputText: transcriptText,
    format,
    backend,
    model,
    policyProfile,
    sourceKind: 'command-output',
    commandExitCode: exitCode,
  });
  const outputText = `${(summaryResult.Summary || 'No summary generated.').trim()}\nRaw transcript: ${transcriptPath}`;

  return {
    ExitCode: exitCode,
    TranscriptPath: transcriptPath,
    WasSummarized: summaryResult.WasSummarized,
    RawReviewRequired: summaryResult.RawReviewRequired || exitCode !== 0,
    OutputText: outputText,
    Summary: summaryResult.Summary,
    Classification: summaryResult.Classification,
    PolicyDecision: summaryResult.PolicyDecision,
  };
}
