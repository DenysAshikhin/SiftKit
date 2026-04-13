import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getConfiguredModel, initializeRuntime, loadConfig } from './config/index.js';
import { summarizeRequest } from './summary/core.js';
import { resolveExternalCommand } from './capture/command-path.js';
import { captureWithTranscript } from './capture/process.js';
import type { SummaryClassification } from './summary/types.js';
import { upsertRuntimeTextArtifact } from './state/runtime-artifacts.js';

export type InteractiveCaptureRequest = {
  Command: string;
  ArgumentList?: string[];
  Question?: string;
  Format?: 'text' | 'json';
  Backend?: string;
  Model?: string;
  PolicyProfile?: 'general' | 'pass-fail' | 'unique-errors' | 'buried-critical' | 'json-extraction' | 'diff-summary' | 'risky-operation';
};

export type InteractiveCaptureResult = {
  ExitCode: number;
  TranscriptPath: string;
  WasSummarized: boolean;
  RawReviewRequired: boolean;
  OutputText: string;
  Summary: string;
  Classification: SummaryClassification;
  PolicyDecision: string;
};

export async function runInteractiveCapture(request: InteractiveCaptureRequest): Promise<InteractiveCaptureResult> {
  const config = await loadConfig({ ensure: true });
  const backend = request.Backend || config.Backend;
  const model = request.Model || getConfiguredModel(config);
  const format = request.Format || 'text';
  const policyProfile = request.PolicyProfile || 'general';
  const question = request.Question || 'Summarize the important result and any actionable failures.';

  void initializeRuntime();
  const transcriptArtifact = upsertRuntimeTextArtifact({
    artifactKind: 'interactive_raw',
    content: '',
  });
  const transcriptPath = transcriptArtifact.uri;
  const resolvedCommand = resolveExternalCommand(request.Command);
  let exitCode = 0;

  let transcriptText = '';
  try {
    // captureWithTranscript expects a filesystem target path, so capture into temp text first.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-interactive-'));
    const tempPath = path.join(tempDir, 'transcript.log');
    exitCode = captureWithTranscript(resolvedCommand, request.ArgumentList || [], tempPath);
    transcriptText = fs.existsSync(tempPath) ? fs.readFileSync(tempPath, 'utf8') : '';
    try {
      fs.rmSync(tempDir, { force: true, recursive: true });
    } catch {
      // Best effort cleanup.
    }
  } catch {
    transcriptText = '';
    exitCode = 1;
  }

  if (config.Interactive.MaxTranscriptCharacters && transcriptText.length > Number(config.Interactive.MaxTranscriptCharacters)) {
    transcriptText = transcriptText.substring(transcriptText.length - Number(config.Interactive.MaxTranscriptCharacters));
  }

  if (!transcriptText.trim()) {
    transcriptText = `Interactive command completed without a captured transcript.\nCommand: ${request.Command} ${(request.ArgumentList || []).join(' ')}\nExitCode: ${exitCode}`;
  }
  upsertRuntimeTextArtifact({
    id: transcriptArtifact.id,
    artifactKind: 'interactive_raw',
    content: transcriptText,
  });

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
