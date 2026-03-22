import * as fs from 'node:fs';
import {
  loadConfig,
  type RuntimeLlamaCppConfig,
  type SiftConfig,
  getChunkThresholdCharacters,
  getConfiguredLlamaBaseUrl,
  getConfiguredLlamaNumCtx,
  getConfiguredModel,
  getConfiguredPromptPrefix,
  notifyStatusBackend,
} from './config.js';
import { withExecutionLock } from './execution-lock.js';
import { countLlamaCppTokens, generateLlamaCppResponse } from './providers/llama-cpp.js';

export type SummaryPolicyProfile = 'general' | 'pass-fail' | 'unique-errors' | 'buried-critical' | 'json-extraction' | 'diff-summary' | 'risky-operation';
export type SummarySourceKind = 'standalone' | 'command-output';
export type SummaryClassification = 'summary' | 'command_failure' | 'unsupported_input';

export const UNSUPPORTED_INPUT_MESSAGE = 'The command/input is either unsupported or failed. Please verify the command that it is supported in the current environment and returns proper input. If it does, raise an explicit error to the user and stop futher processing.';

export type SummaryRequest = {
  question: string;
  inputText: string;
  format: 'text' | 'json';
  policyProfile: SummaryPolicyProfile;
  backend?: string;
  model?: string;
  promptPrefix?: string;
  sourceKind?: SummarySourceKind;
  commandExitCode?: number | null;
  llamaCppOverrides?: Pick<
    RuntimeLlamaCppConfig,
    'Temperature' | 'TopP' | 'TopK' | 'MinP' | 'PresencePenalty' | 'RepetitionPenalty' | 'MaxTokens'
  >;
};

export type SummaryResult = {
  WasSummarized: boolean;
  PolicyDecision: string;
  Backend: string;
  Model: string;
  Summary: string;
  Classification: SummaryClassification;
  RawReviewRequired: boolean;
  ModelCallSucceeded: boolean;
  ProviderError: string | null;
};

type SummaryDecision = {
  ShouldSummarize: boolean;
  Reason: string;
  RawReviewRequired: boolean;
  CharacterCount: number;
  LineCount: number;
};

type QuestionAnalysis = {
  IsExactDiagnosis: boolean;
  Reason: string | null;
};

type StructuredModelDecision = {
  classification: SummaryClassification;
  rawReviewRequired: boolean;
  output: string;
};

const PROMPT_PROFILES: Record<SummaryPolicyProfile, string> = {
  general: [
    'Summarize only the information supported by the input.',
    'Lead with the main conclusion before supporting evidence.',
    'Do not invent causes, fixes, or certainty that the input does not support.',
  ].join('\n'),
  'pass-fail': [
    'Focus on pass/fail status.',
    'If failures exist, lead with the failing status and the decisive failure reason.',
    'Do not spend space on passing tests unless they matter to a caveat.',
  ].join('\n'),
  'unique-errors': [
    'Extract unique real errors.',
    'Group repeated lines.',
    'Ignore informational noise and warnings unless they directly indicate failure.',
  ].join('\n'),
  'buried-critical': [
    'Identify the single decisive failure or highest-priority problem if one exists.',
    'Ignore repeated harmless lines.',
  ].join('\n'),
  'json-extraction': [
    'Produce the requested extraction faithfully.',
    'If classification is summary or command_failure, the output payload itself must be valid JSON text.',
  ].join('\n'),
  'diff-summary': [
    'Summarize functional changes, not formatting churn.',
    'Distinguish behavior changes from refactors when possible.',
  ].join('\n'),
  'risky-operation': [
    'Be conservative.',
    'Do not judge the operation safe.',
    'Highlight destructive or risky actions and set raw_review_required to true.',
  ].join('\n'),
};

function normalizeInputText(text: string | null | undefined): string | null {
  if (text === null || text === undefined) {
    return null;
  }

  return text.replace(/[\r\n]+$/u, '');
}

function measureText(text: string): {
  CharacterCount: number;
  LineCount: number;
} {
  const normalized = text.replace(/\r\n/gu, '\n');
  return {
    CharacterCount: text.length,
    LineCount: normalized.length > 0 ? normalized.split('\n').length : 0,
  };
}

function getQuestionAnalysis(question: string | null | undefined): QuestionAnalysis {
  const normalized = question ? question.toLowerCase() : '';
  const patterns = [
    { pattern: /file matching|exact file|find files|exact match/u, reason: 'exact-file-match' },
    { pattern: /schema|summarize schema/u, reason: 'schema-inspection' },
    { pattern: /summarize conflicts|conflict/u, reason: 'conflict-review' },
    { pattern: /summarize edits|edited|diff|patch/u, reason: 'edit-review' },
    { pattern: /root exception|first relevant application frame|first relevant frame/u, reason: 'stack-triage' },
  ];

  for (const entry of patterns) {
    if (entry.pattern.test(normalized)) {
      return {
        IsExactDiagnosis: true,
        Reason: entry.reason,
      };
    }
  }

  return {
    IsExactDiagnosis: false,
    Reason: null,
  };
}

function getErrorSignalMetrics(text: string): {
  NonEmptyLineCount: number;
  ErrorLineCount: number;
  ErrorRatio: number;
} {
  const lines = text.replace(/\r\n/gu, '\n').split('\n');
  let nonEmptyLineCount = 0;
  let errorLineCount = 0;
  const errorPattern = /\b(error|exception|traceback|fatal|conflict|denied|panic|timed out|timeout|script error|parse error)\b/iu;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    nonEmptyLineCount += 1;
    if (/\b0 failed\b/iu.test(trimmed) && !/\b([1-9]\d*|all)\s+failed\b/iu.test(trimmed)) {
      continue;
    }
    if (errorPattern.test(trimmed)) {
      errorLineCount += 1;
    }
  }

  return {
    NonEmptyLineCount: nonEmptyLineCount,
    ErrorLineCount: errorLineCount,
    ErrorRatio: nonEmptyLineCount > 0 ? errorLineCount / nonEmptyLineCount : 0,
  };
}

export function getDeterministicExcerpt(text: string | null | undefined, question: string | null | undefined): string | null {
  if (!text || !text.trim()) {
    return null;
  }

  const lines = text.replace(/\r\n/gu, '\n').split('\n');
  const significant: string[] = [];
  const analysis = getQuestionAnalysis(question);
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    if (
      /\b(fatal|error|exception|traceback|failed|conflict|<<<<<<<|>>>>>>>|schema|stderr)\b/iu.test(line)
      || (analysis.IsExactDiagnosis && /\b(test|assert|frame|file|table|column|constraint)\b/iu.test(line))
    ) {
      significant.push(line.trim());
    }

    if (significant.length >= 12) {
      break;
    }
  }

  if (significant.length === 0) {
    return null;
  }

  return [...new Set(significant)].join('\n');
}

export function getSummaryDecision(text: string, question: string | null | undefined, riskLevel: 'informational' | 'debug' | 'risky', config: SiftConfig): SummaryDecision {
  const metrics = measureText(text);
  const errorMetrics = getErrorSignalMetrics(text);
  const hasMaterialErrorSignals = (
    errorMetrics.ErrorLineCount > 0
    && (
      errorMetrics.NonEmptyLineCount <= 20
      || (errorMetrics.ErrorLineCount >= 5 && errorMetrics.ErrorRatio >= 0.25)
      || errorMetrics.ErrorRatio >= 0.25
    )
  );
  const isShort = (
    metrics.CharacterCount < Number(config.Thresholds.MinCharactersForSummary)
    && metrics.LineCount < Number(config.Thresholds.MinLinesForSummary)
  );
  const rawReviewRequired = riskLevel !== 'informational' || hasMaterialErrorSignals;
  const reason = isShort
    ? 'model-first-short'
    : (rawReviewRequired ? 'model-first-risk-review' : 'model-first');

  return {
    ShouldSummarize: true,
    Reason: question ? reason : 'model-first',
    RawReviewRequired: rawReviewRequired,
    CharacterCount: metrics.CharacterCount,
    LineCount: metrics.LineCount,
  };
}

function splitTextIntoChunks(text: string, chunkSize: number): string[] {
  if (chunkSize <= 0) {
    throw new Error('ChunkSize must be greater than zero.');
  }

  if (text.length <= chunkSize) {
    return [text];
  }

  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += chunkSize) {
    chunks.push(text.substring(offset, Math.min(offset + chunkSize, text.length)));
  }
  return chunks;
}

function shouldRetryWithSmallerChunks(options: {
  error: unknown;
  backend: string;
  inputText: string;
  chunkThreshold: number;
}): boolean {
  if (options.backend !== 'llama.cpp') {
    return false;
  }

  if (options.chunkThreshold <= 1 || options.inputText.length <= 1) {
    return false;
  }

  const message = options.error instanceof Error ? options.error.message : String(options.error);
  return /llama\.cpp generate failed with HTTP 400\b/iu.test(message);
}

const LLAMA_CPP_PROMPT_TOKEN_RESERVE = 1024;

function getTokenAwareChunkThreshold(options: {
  inputLength: number;
  promptTokenCount: number;
  effectivePromptLimit: number;
}): number | null {
  if (
    options.inputLength <= 1
    || options.promptTokenCount <= options.effectivePromptLimit
    || options.effectivePromptLimit <= 0
  ) {
    return null;
  }

  const scaledThreshold = Math.floor(
    options.inputLength * (options.effectivePromptLimit / options.promptTokenCount) * 0.95
  );
  const reducedThreshold = Math.max(1, Math.min(options.inputLength - 1, scaledThreshold));
  return reducedThreshold < options.inputLength ? reducedThreshold : null;
}

function appendTestProviderEvent(event: Record<string, unknown>): void {
  const logPath = process.env.SIFTKIT_TEST_PROVIDER_LOG_PATH;
  if (!logPath || !logPath.trim()) {
    return;
  }

  fs.appendFileSync(logPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8' });
}

function extractPromptSection(prompt: string, header: string): string {
  const escapedHeader = header.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = new RegExp(`${escapedHeader}\\n([\\s\\S]*?)(?:\\n[A-Z][^\\n]*:\\n|$)`, 'u');
  const match = pattern.exec(prompt);
  return match ? match[1].trim() : '';
}

function toMockDecision(decision: StructuredModelDecision): string {
  return JSON.stringify({
    classification: decision.classification,
    raw_review_required: decision.rawReviewRequired,
    output: decision.output,
  });
}

function buildMockDecision(prompt: string, question: string, phase: 'leaf' | 'merge'): StructuredModelDecision {
  const inputText = extractPromptSection(prompt, 'Input:');

  if (!inputText.trim() || /unsupported fixture marker/u.test(inputText)) {
    return {
      classification: 'unsupported_input',
      rawReviewRequired: false,
      output: UNSUPPORTED_INPUT_MESSAGE,
    };
  }

  if (/Return only valid JSON/u.test(prompt)) {
    return {
      classification: 'summary',
      rawReviewRequired: false,
      output: '[{"package":"lodash","severity":"high","title":"demo","fix_version":"1.0.0"}]',
    };
  }

  if (/Could not find type "Active_Buffs"/u.test(inputText)) {
    return {
      classification: 'summary',
      rawReviewRequired: true,
      output: 'The smoke run is failing during script compilation. The decisive failure is parse errors in Global.gd for missing types like Active_Buffs, Bases, and Infos.\nRaw review required.',
    };
  }

  if (/TARGET_VALID/u.test(inputText) && /resources still in use at exit/u.test(inputText)) {
    return {
      classification: 'summary',
      rawReviewRequired: true,
      output: 'The run passed numerically but is still not clean. Shutdown integrity failed because the log includes freed-object script errors and resources still in use at exit.\nRaw review required.',
    };
  }

  if (/ACTION_VALIDATE_FAIL/u.test(inputText) && /warp\/set_stay_100pct/u.test(inputText)) {
    return {
      classification: 'summary',
      rawReviewRequired: true,
      output: 'This run failed autonomous-mode validation. The decisive failure is warp/set_stay_100pct because the stay threshold was not set to 100%.\nRaw review required.',
    };
  }

  if (/save_file_loaded/u.test(inputText) && /Global\.gd/u.test(inputText)) {
    return {
      classification: 'summary',
      rawReviewRequired: true,
      output: 'This run is not clean. The log contains repeated script errors on Global.gd, including invalid access to save_file_loaded, Drones, Motherships, and KEY_EXPORT.\nRaw review required.',
    };
  }

  if ((/TEST HARNESS:/u.test(inputText) && /0 failed/u.test(inputText)) || /pass markers alone do not prove/u.test(inputText)) {
    return {
      classification: 'summary',
      rawReviewRequired: true,
      output: 'These logs show explicit numeric pass markers in historical runs. Pass markers alone do not prove the runs were clean because other logs in the same set can still contain script errors or shutdown issues.\nRaw review required.',
    };
  }

  if (phase === 'merge' || question.startsWith('Merge these partial summaries into one final answer')) {
    if (/pass markers alone do not prove|numeric pass markers/i.test(inputText)) {
      return {
        classification: 'summary',
        rawReviewRequired: true,
        output: 'These logs show explicit numeric pass markers in historical runs. Pass markers alone do not prove the runs were clean because other logs in the same set can still contain script errors or shutdown issues.\nRaw review required.',
      };
    }
    if (/run is not clean|script errors/i.test(inputText)) {
      return {
        classification: 'summary',
        rawReviewRequired: true,
        output: 'This run is not clean. The log contains repeated script errors and related runtime failures.\nRaw review required.',
      };
    }
    if (/failed autonomous-mode validation|stay threshold/i.test(inputText)) {
      return {
        classification: 'summary',
        rawReviewRequired: true,
        output: 'This run failed autonomous-mode validation. The decisive failure is warp/set_stay_100pct because the stay threshold was not set to 100%.\nRaw review required.',
      };
    }
    if (/shutdown integrity failed|resources still in use at exit/i.test(inputText)) {
      return {
        classification: 'summary',
        rawReviewRequired: true,
        output: 'The run passed numerically but is still not clean. Shutdown integrity failed because the log includes freed-object script errors and resources still in use at exit.\nRaw review required.',
      };
    }
    if (/failing during script compilation|parse errors/i.test(inputText)) {
      return {
        classification: 'summary',
        rawReviewRequired: true,
        output: 'The smoke run is failing during script compilation. The decisive failure is parse errors in Global.gd for missing types like Active_Buffs, Bases, and Infos.\nRaw review required.',
      };
    }
  }

  if (/Unable to resolve external command/u.test(inputText) || /is not recognized as an internal or external command/u.test(inputText)) {
    return {
      classification: 'command_failure',
      rawReviewRequired: true,
      output: 'The command failed before producing a usable result. The executable could not be resolved in the current environment.\nRaw review required.',
    };
  }

  if (/did tests pass/u.test(question)) {
    return {
      classification: 'summary',
      rawReviewRequired: true,
      output: 'Tests did not pass cleanly. The decisive failures are test_order_processing and test_auth_timeout.\nRaw review required.',
    };
  }

  if (/resources added, changed, and destroyed/u.test(question)) {
    return {
      classification: 'summary',
      rawReviewRequired: true,
      output: 'This output includes a destructive infrastructure change. The decisive action is destroy aws_db_instance.main.\nRaw review required.',
    };
  }

  return {
    classification: 'summary',
    rawReviewRequired: false,
    output: 'mock summary',
  };
}

function getMockSummary(prompt: string, question: string, phase: 'leaf' | 'merge'): string {
  const behavior = process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR?.trim() || '';
  if (behavior === 'throw') {
    throw new Error('mock provider failure');
  }
  if (behavior === 'recursive-merge') {
    if (phase === 'merge' || question.startsWith('Merge these partial summaries into one final answer')) {
      return toMockDecision({
        classification: 'summary',
        rawReviewRequired: false,
        output: 'merge summary',
      });
    }
    return toMockDecision({
      classification: 'summary',
      rawReviewRequired: false,
      output: 'L'.repeat(150000),
    });
  }

  const token = process.env.SIFTKIT_TEST_TOKEN;
  const decision = buildMockDecision(prompt, question, phase);
  if (token && decision.output === 'mock summary') {
    decision.output = `mock summary ${token}`;
  }
  return toMockDecision(decision);
}

async function invokeProviderSummary(options: {
  backend: string;
  config: SiftConfig;
  model: string;
  prompt: string;
  question: string;
  promptCharacterCount: number;
  rawInputCharacterCount: number;
  chunkInputCharacterCount: number;
  phase: 'leaf' | 'merge';
  chunkIndex: number | null;
  chunkTotal: number | null;
  llamaCppOverrides?: SummaryRequest['llamaCppOverrides'];
}): Promise<string> {
  await notifyStatusBackend({
    running: true,
    promptCharacterCount: options.promptCharacterCount,
    rawInputCharacterCount: options.rawInputCharacterCount,
    chunkInputCharacterCount: options.chunkInputCharacterCount,
    budgetSource: options.config.Effective?.BudgetSource ?? null,
    inputCharactersPerContextToken: options.config.Effective?.InputCharactersPerContextToken ?? null,
    chunkThresholdCharacters: options.config.Effective?.ChunkThresholdCharacters ?? null,
    phase: options.phase,
    chunkIndex: options.chunkIndex,
    chunkTotal: options.chunkTotal,
  });
  const startedAt = Date.now();
  let inputTokens: number | null = null;
  let outputCharacterCount: number | null = null;
  let outputTokens: number | null = null;
  let thinkingTokens: number | null = null;
  try {
    if (options.backend === 'mock') {
      const rawSleep = process.env.SIFTKIT_TEST_PROVIDER_SLEEP_MS;
      const sleepMs = rawSleep ? Number.parseInt(rawSleep, 10) : 0;
      if (Number.isFinite(sleepMs) && sleepMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, sleepMs));
      }
      appendTestProviderEvent({
        backend: options.backend,
        model: options.model,
        phase: options.phase,
        question: options.question,
        rawInputCharacterCount: options.rawInputCharacterCount,
        chunkInputCharacterCount: options.chunkInputCharacterCount,
      });
      const mockSummary = getMockSummary(options.prompt, options.question, options.phase);
      outputCharacterCount = mockSummary.length;
      return mockSummary;
    }

    const response = await generateLlamaCppResponse({
      config: options.config,
      model: options.model,
      prompt: options.prompt,
      timeoutSeconds: 600,
      overrides: options.llamaCppOverrides,
    });
    inputTokens = response.usage?.promptTokens ?? null;
    outputCharacterCount = response.text.length;
    outputTokens = response.usage?.completionTokens ?? null;
    thinkingTokens = response.usage?.thinkingTokens ?? null;
    return response.text.trim();
  } finally {
    await notifyStatusBackend({
      running: false,
      promptCharacterCount: options.promptCharacterCount,
      inputTokens,
      outputCharacterCount,
      outputTokens,
      thinkingTokens,
      requestDurationMs: Date.now() - startedAt,
    });
  }
}

function getSourceInstructions(sourceKind: SummarySourceKind, commandExitCode: number | null | undefined): string {
  if (sourceKind === 'command-output') {
    const exitCodeLine = commandExitCode === null || commandExitCode === undefined
      ? 'Command exit code: unknown.'
      : `Command exit code: ${commandExitCode}.`;
    return [
      'Input kind: command output from the current environment.',
      exitCodeLine,
      'Decide whether the command itself failed or whether it succeeded and the output is reporting application/log/runtime failures.',
      'Use classification "command_failure" only when the command/input itself failed or the output is unsupported/unusable for the requested question.',
    ].join('\n');
  }

  return [
    'Input kind: standalone text or captured log review.',
    'Treat this as content to analyze, not as a live command execution result.',
    'Use classification "summary" unless the input is unsupported or unusable for the requested question.',
  ].join('\n');
}

export function buildPrompt(options: {
  question: string;
  inputText: string;
  format: 'text' | 'json';
  policyProfile: SummaryPolicyProfile;
  rawReviewRequired: boolean;
  promptPrefix?: string;
  sourceKind?: SummarySourceKind;
  commandExitCode?: number | null;
  phase?: 'leaf' | 'merge';
}): string {
  const profilePrompt = PROMPT_PROFILES[options.policyProfile] || PROMPT_PROFILES.general;
  const rawReviewPrompt = options.rawReviewRequired
    ? 'Raw-log review is likely required. Set raw_review_required to true unless the input clearly proves otherwise.'
    : 'Set raw_review_required based on the evidence. Use true for risky, incomplete, or failure-related output.';
  const outputFormatPrompt = options.format === 'json'
    ? 'The output field must be valid JSON text, not markdown.'
    : 'The output field must be concise plain text with the conclusion first.';
  const phasePrompt = options.phase === 'merge'
    ? 'You are merging chunk-level SiftKit decisions into one final decision for the original question.'
    : 'You are SiftKit, a conservative shell-output compressor for Codex workflows.';

  const sections = [
    phasePrompt,
    '',
    'Rules:',
    '- Preserve the most decisive facts.',
    '- Prefer conclusion-first synthesis over raw extraction.',
    '- Never claim certainty beyond the input.',
    '- If evidence is incomplete or ambiguous, say so.',
    '- Do not suggest destructive actions.',
    '- Return only a valid JSON object. No markdown fences.',
    '',
    'Classification schema:',
    '- "summary": the input is usable and should be summarized normally.',
    '- "command_failure": the command/input itself failed and that failure should be reported.',
    `- "unsupported_input": the input is unsupported or unusable; output must be exactly "${UNSUPPORTED_INPUT_MESSAGE}".`,
    '',
    'Response JSON shape:',
    '{"classification":"summary|command_failure|unsupported_input","raw_review_required":true,"output":"final answer text"}',
    '',
    'Source handling:',
    getSourceInstructions(options.sourceKind || 'standalone', options.commandExitCode),
    '',
    'Profile:',
    profilePrompt,
    '',
    'Output requirements:',
    outputFormatPrompt,
    'If raw_review_required is true and classification is not "unsupported_input", include the exact sentence "Raw review required." in the output.',
    '',
    'Risk handling:',
    rawReviewPrompt,
    '',
    'Question:',
    options.question,
    '',
    'Input:',
    options.inputText,
  ];

  const promptPrefix = options.promptPrefix?.trim();
  return promptPrefix
    ? [promptPrefix, '', ...sections].join('\n')
    : sections.join('\n');
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(trimmed);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

function parseStructuredModelDecision(text: string): StructuredModelDecision {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripCodeFence(text)) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Provider returned an invalid SiftKit decision payload: ${message}`);
  }

  const classification = typeof parsed.classification === 'string'
    ? parsed.classification.trim().toLowerCase()
    : '';
  if (!['summary', 'command_failure', 'unsupported_input'].includes(classification)) {
    throw new Error('Provider returned an invalid SiftKit decision classification.');
  }

  const output = parsed.output;
  if (typeof output !== 'string' || !output.trim()) {
    throw new Error('Provider returned an empty SiftKit decision output.');
  }

  return {
    classification: classification as SummaryClassification,
    rawReviewRequired: Boolean(parsed.raw_review_required ?? parsed.rawReviewRequired ?? false),
    output: output.trim(),
  };
}

function ensureRawReviewSentence(decision: StructuredModelDecision, format: 'text' | 'json'): StructuredModelDecision {
  if (!decision.rawReviewRequired || decision.classification === 'unsupported_input' || format === 'json') {
    return decision;
  }

  if (/\bRaw review required\./u.test(decision.output)) {
    return decision;
  }

  return {
    ...decision,
    output: `${decision.output.trim()}\nRaw review required.`,
  };
}

function normalizeStructuredDecision(decision: StructuredModelDecision, format: 'text' | 'json'): StructuredModelDecision {
  if (decision.classification === 'unsupported_input') {
    return {
      classification: 'unsupported_input',
      rawReviewRequired: false,
      output: UNSUPPORTED_INPUT_MESSAGE,
    };
  }

  return ensureRawReviewSentence(decision, format);
}

async function invokeSummaryCore(options: {
  question: string;
  inputText: string;
  format: 'text' | 'json';
  policyProfile: SummaryPolicyProfile;
  backend: string;
  model: string;
  config: SiftConfig;
  rawReviewRequired: boolean;
  sourceKind: SummarySourceKind;
  commandExitCode?: number | null;
  rootInputCharacterCount?: number | null;
  phase?: 'leaf' | 'merge';
  chunkIndex?: number | null;
  chunkTotal?: number | null;
  chunkThresholdOverride?: number | null;
  promptPrefix?: string;
  llamaCppOverrides?: SummaryRequest['llamaCppOverrides'];
}): Promise<StructuredModelDecision> {
  const rootInputCharacterCount = options.rootInputCharacterCount ?? options.inputText.length;
  const phase = options.phase ?? 'leaf';
  const chunkThreshold = Math.max(
    1,
    Math.floor(options.chunkThresholdOverride ?? getChunkThresholdCharacters(options.config))
  );
  if (options.inputText.length > chunkThreshold) {
    const chunks = splitTextIntoChunks(options.inputText, chunkThreshold);
    const chunkDecisions: StructuredModelDecision[] = [];

    for (let index = 0; index < chunks.length; index += 1) {
      const decision = await invokeSummaryCore({
        ...options,
        inputText: chunks[index],
        rootInputCharacterCount,
        phase,
        chunkIndex: index + 1,
        chunkTotal: chunks.length,
      });
      chunkDecisions.push(decision);
    }

    const mergeSections: string[] = [];
    for (let index = 0; index < chunkDecisions.length; index += 1) {
      mergeSections.push(`Chunk ${index + 1}:`);
      mergeSections.push(`classification=${chunkDecisions[index].classification}`);
      mergeSections.push(`raw_review_required=${chunkDecisions[index].rawReviewRequired}`);
      mergeSections.push(chunkDecisions[index].output);
      if (index < chunkDecisions.length - 1) {
        mergeSections.push('');
      }
    }

    return invokeSummaryCore({
      ...options,
      question: `Merge these partial summaries into one final answer for the original question: ${options.question}`,
      inputText: mergeSections.join('\n'),
      rawReviewRequired: options.rawReviewRequired || chunkDecisions.some((decision) => decision.rawReviewRequired),
      rootInputCharacterCount,
      phase: 'merge',
      chunkIndex: null,
      chunkTotal: null,
    });
  }

  const prompt = buildPrompt({
    question: options.question,
    inputText: options.inputText,
    format: options.format,
    policyProfile: options.policyProfile,
    rawReviewRequired: options.rawReviewRequired,
    promptPrefix: options.promptPrefix,
    sourceKind: options.sourceKind,
    commandExitCode: options.commandExitCode,
    phase,
  });
  const effectivePromptLimit = options.backend === 'llama.cpp'
    ? getConfiguredLlamaNumCtx(options.config) - LLAMA_CPP_PROMPT_TOKEN_RESERVE
    : null;
  const promptTokenCount = effectivePromptLimit !== null && effectivePromptLimit > 0
    ? await countLlamaCppTokens(options.config, prompt)
    : null;
  const preflightChunkThreshold = effectivePromptLimit !== null && promptTokenCount !== null
    ? getTokenAwareChunkThreshold({
      inputLength: options.inputText.length,
      promptTokenCount,
      effectivePromptLimit,
    })
    : null;
  if (preflightChunkThreshold !== null) {
    return invokeSummaryCore({
      ...options,
      chunkThresholdOverride: preflightChunkThreshold,
      chunkIndex: options.chunkIndex ?? null,
      chunkTotal: options.chunkTotal ?? null,
    });
  }

  try {
    const rawResponse = await invokeProviderSummary({
      backend: options.backend,
      config: options.config,
      model: options.model,
      prompt,
      question: options.question,
      promptCharacterCount: prompt.length,
      rawInputCharacterCount: rootInputCharacterCount,
      chunkInputCharacterCount: options.inputText.length,
      phase,
      chunkIndex: options.chunkIndex ?? null,
      chunkTotal: options.chunkTotal ?? null,
      llamaCppOverrides: options.llamaCppOverrides,
    });
    return normalizeStructuredDecision(parseStructuredModelDecision(rawResponse), options.format);
  } catch (error) {
    if (!shouldRetryWithSmallerChunks({
      error,
      backend: options.backend,
      inputText: options.inputText,
      chunkThreshold,
    })) {
      throw error;
    }

    const reducedThreshold = (
      effectivePromptLimit !== null && promptTokenCount !== null
        ? getTokenAwareChunkThreshold({
          inputLength: options.inputText.length,
          promptTokenCount,
          effectivePromptLimit,
        })
        : null
    ) ?? Math.max(1, Math.min(chunkThreshold - 1, Math.floor(options.inputText.length / 2)));
    if (reducedThreshold >= options.inputText.length) {
      throw error;
    }

    return invokeSummaryCore({
      ...options,
      chunkThresholdOverride: reducedThreshold,
      chunkIndex: options.chunkIndex ?? null,
      chunkTotal: options.chunkTotal ?? null,
    });
  }
}

function getPolicyDecision(classification: SummaryClassification): SummaryResult['PolicyDecision'] {
  if (classification === 'command_failure') {
    return 'model-command-failure';
  }
  if (classification === 'unsupported_input') {
    return 'model-unsupported-input';
  }
  return 'model-summary';
}

export async function summarizeRequest(request: SummaryRequest): Promise<SummaryResult> {
  const inputText = normalizeInputText(request.inputText);
  if (!inputText || !inputText.trim()) {
    throw new Error('Provide --text, --file, or pipe input into siftkit.');
  }

  return withExecutionLock(async () => {
    const config = await loadConfig({ ensure: true });
    getConfiguredLlamaBaseUrl(config);
    getConfiguredLlamaNumCtx(config);
    const backend = request.backend || config.Backend;
    const model = request.model || getConfiguredModel(config);
    const riskLevel = request.policyProfile === 'risky-operation' ? 'risky' : 'informational';
    const decision = getSummaryDecision(inputText, request.question, riskLevel, config);
    const effectivePromptPrefix = request.promptPrefix !== undefined
      ? request.promptPrefix
      : getConfiguredPromptPrefix(config);
    const modelDecision = await invokeSummaryCore({
      question: request.question,
      inputText,
      format: request.format,
      policyProfile: request.policyProfile,
      backend,
      model,
      config,
      rawReviewRequired: decision.RawReviewRequired,
      sourceKind: request.sourceKind || 'standalone',
      commandExitCode: request.commandExitCode,
      promptPrefix: effectivePromptPrefix,
      llamaCppOverrides: request.llamaCppOverrides,
    });

    return {
      WasSummarized: modelDecision.classification !== 'unsupported_input',
      PolicyDecision: getPolicyDecision(modelDecision.classification),
      Backend: backend,
      Model: model,
      Summary: modelDecision.output.trim(),
      Classification: modelDecision.classification,
      RawReviewRequired: modelDecision.rawReviewRequired,
      ModelCallSucceeded: true,
      ProviderError: null,
    };
  });
}

export function readSummaryInput(options: {
  text?: string;
  file?: string;
  stdinText?: string;
}): string | null {
  if (options.text !== undefined) {
    return normalizeInputText(options.text);
  }

  if (options.file) {
    if (!fs.existsSync(options.file)) {
      if (options.stdinText !== undefined) {
        return normalizeInputText(options.stdinText);
      }
      throw new Error(`Input file not found: ${options.file}`);
    }
    return normalizeInputText(fs.readFileSync(options.file, 'utf8'));
  }

  if (options.stdinText !== undefined) {
    return normalizeInputText(options.stdinText);
  }

  return null;
}
