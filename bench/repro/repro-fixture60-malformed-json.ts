#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import {
  loadConfig,
  getChunkThresholdCharacters,
  getConfiguredLlamaNumCtx,
  getConfiguredLlamaSetting,
  getConfiguredModel,
  getConfiguredPromptPrefix,
  getEffectiveInputCharactersPerContextToken,
} from '../../src/config/index.js';
import { acquireExecutionLock, releaseExecutionLock } from '../../src/execution-lock.js';
import { buildPrompt, getSummaryDecision, planTokenAwareLlamaCppChunks } from '../../src/summary.js';
import { countLlamaCppTokens, generateLlamaCppResponse } from '../../src/providers/llama-cpp.js';
import { ModelJson } from '../../src/lib/model-json.js';
import { getErrorMessage } from '../../src/lib/errors.js';
import { parseJsonValueText } from '../../src/lib/json.js';
import type { JsonObject, JsonSerializable } from '../../src/lib/json-types.js';
import type { SiftConfig } from '../../src/config/index.js';

const LLAMA_CPP_NON_THINKING_PROMPT_TOKEN_RESERVE = 10_000;
const LLAMA_CPP_THINKING_PROMPT_TOKEN_RESERVE = 15_000;

export function parseArgs(argv: string[]): {
  fixtureIndex: number;
  fixtureStartIndex: number | null;
  fixtureEndIndex: number | null;
  outputRoot: string;
  requestTimeoutSeconds: number;
  traceSummary: boolean;
} {
  const parsed = {
    fixtureIndex: 60,
    fixtureStartIndex: null,
    fixtureEndIndex: null,
    outputRoot: '',
    requestTimeoutSeconds: 1800,
    traceSummary: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case '--fixture-index':
        parsed.fixtureIndex = Number(argv[++index]);
        break;
      case '--fixture-start-index':
        parsed.fixtureStartIndex = Number(argv[++index]);
        break;
      case '--fixture-end-index':
        parsed.fixtureEndIndex = Number(argv[++index]);
        break;
      case '--output-root':
        parsed.outputRoot = path.resolve(String(argv[++index] || ''));
        break;
      case '--request-timeout-seconds':
        parsed.requestTimeoutSeconds = Number(argv[++index]);
        break;
      case '--trace-summary':
        parsed.traceSummary = String(argv[++index] || '') !== '0';
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  if (!Number.isInteger(parsed.fixtureIndex) || parsed.fixtureIndex <= 0) {
    throw new Error('fixture-index must be a positive integer.');
  }
  if (parsed.fixtureStartIndex !== null && (!Number.isInteger(parsed.fixtureStartIndex) || parsed.fixtureStartIndex <= 0)) {
    throw new Error('fixture-start-index must be a positive integer.');
  }
  if (parsed.fixtureEndIndex !== null && (!Number.isInteger(parsed.fixtureEndIndex) || parsed.fixtureEndIndex <= 0)) {
    throw new Error('fixture-end-index must be a positive integer.');
  }
  if (!Number.isFinite(parsed.requestTimeoutSeconds) || parsed.requestTimeoutSeconds <= 0) {
    throw new Error('request-timeout-seconds must be a positive number.');
  }

  return parsed;
}

function getTimestamp(): string {
  const current = new Date();
  const yyyy = current.getFullYear();
  const MM = String(current.getMonth() + 1).padStart(2, '0');
  const dd = String(current.getDate()).padStart(2, '0');
  const hh = String(current.getHours()).padStart(2, '0');
  const mm = String(current.getMinutes()).padStart(2, '0');
  const ss = String(current.getSeconds()).padStart(2, '0');
  return `${yyyy}${MM}${dd}_${hh}${mm}${ss}`;
}

function createLogger(
  logPath: string,
  stdoutTarget: { write: (text: string) => void } = process.stdout,
): { log: (message: string) => void } {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, '', 'utf8');
  return {
    log(message: string) {
      const line = `[fixture60-repro ${new Date().toISOString()}] ${message}`;
      stdoutTarget.write(`${line}\n`);
      fs.appendFileSync(logPath, `${line}\n`, 'utf8');
    },
  };
}

export function resolveWorkItems(
  fixtureRoot: string,
  fixtureStartIndex: number,
  fixtureEndIndex: number,
): Array<{
  fixtureIndex: number;
  fixture: JsonObject;
  sourcePath: string;
  inputText: string;
}> {
  const manifestPath = path.join(fixtureRoot, 'fixtures.json');
  const manifest = parseJsonValueText(fs.readFileSync(manifestPath, 'utf8'));
  const workItems = [];
  for (let fixtureIndex = fixtureStartIndex; fixtureIndex <= fixtureEndIndex; fixtureIndex += 1) {
    const fixture = manifest[fixtureIndex - 1];
    if (!fixture) {
      throw new Error(`Fixture ${fixtureIndex} not found in ${manifestPath}.`);
    }
    const sourcePath = path.join(fixtureRoot, String(fixture.File || ''));
    workItems.push({
      fixtureIndex,
      fixture,
      sourcePath,
      inputText: fs.readFileSync(sourcePath, 'utf8'),
    });
  }
  return workItems;
}

function writeJson(filePath: string, value: JsonSerializable): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function splitTextIntoChunks(text: string, chunkSize: number): string[] {
  if (chunkSize <= 0) {
    throw new Error('chunkSize must be greater than zero.');
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

function getLlamaCppPromptTokenReserve(config: SiftConfig): number {
  const reasoning = getConfiguredLlamaSetting(config, 'Reasoning');
  return reasoning === 'off'
    ? LLAMA_CPP_NON_THINKING_PROMPT_TOKEN_RESERVE
    : LLAMA_CPP_THINKING_PROMPT_TOKEN_RESERVE;
}

function getLlamaCppChunkThresholdCharacters(config: SiftConfig): number {
  const reserveChars = Math.ceil(getLlamaCppPromptTokenReserve(config) * getEffectiveInputCharactersPerContextToken(config));
  return Math.max(getChunkThresholdCharacters(config) - reserveChars, 1);
}

function getFixtureBounds(args: {
  fixtureIndex: number;
  fixtureStartIndex: number | null;
  fixtureEndIndex: number | null;
}): { fixtureStartIndex: number; fixtureEndIndex: number } {
  const fixtureStartIndex = args.fixtureStartIndex ?? args.fixtureEndIndex ?? args.fixtureIndex;
  const fixtureEndIndex = args.fixtureEndIndex ?? args.fixtureStartIndex ?? args.fixtureIndex;
  if (fixtureStartIndex > fixtureEndIndex) {
    throw new Error('fixture-start-index must be less than or equal to fixture-end-index.');
  }
  return { fixtureStartIndex, fixtureEndIndex };
}

function buildFixtureManifest(
  workItem: { fixtureIndex: number; fixture: JsonObject; sourcePath: string },
  backend: string,
  model: string,
  requestTimeoutSeconds: number,
): JsonObject {
  return {
    ok: false,
    fixtureIndex: workItem.fixtureIndex,
    sourcePath: workItem.sourcePath,
    fixtureName: workItem.fixture.Name,
    backend,
    model,
    requestTimeoutSeconds,
    rawReviewRequired: false,
    chunkThreshold: 0,
    effectivePromptLimit: 0,
    chunkCount: 0,
    malformedChunk: null,
    chunks: [],
  };
}

function mirrorFixtureSummary(manifest: JsonObject, fixtureManifest: JsonObject): void {
  manifest.fixtureIndex = fixtureManifest.fixtureIndex;
  manifest.sourcePath = fixtureManifest.sourcePath;
  manifest.fixtureName = fixtureManifest.fixtureName;
  manifest.rawReviewRequired = fixtureManifest.rawReviewRequired;
  manifest.chunkThreshold = fixtureManifest.chunkThreshold;
  manifest.effectivePromptLimit = fixtureManifest.effectivePromptLimit;
  manifest.chunkCount = fixtureManifest.chunkCount;
  manifest.malformedChunk = fixtureManifest.malformedChunk;
  manifest.chunks = fixtureManifest.chunks;
}

export async function runFixture60MalformedJsonRepro(
  argv: string[],
  options: {
    fixtureRoot?: string;
    stdout?: { write: (text: string) => void };
    stderr?: { write: (text: string) => void };
  } = {},
): Promise<{
  exitCode: number;
  manifestPath: string;
  manifest: JsonObject;
}> {
  const args = parseArgs(argv);
  const { fixtureStartIndex, fixtureEndIndex } = getFixtureBounds(args);
  const repoRoot = path.resolve(__dirname, '..', '..');
  const fixtureRoot = options.fixtureRoot || path.join(repoRoot, 'eval', 'fixtures', 'ai_core_60_tests');
  const outputRoot = args.outputRoot || path.join(repoRoot, 'tmp-find', `fixture60_malformed_json_${getTimestamp()}`);
  const logPath = path.join(outputRoot, 'debug.log');
  const manifestPath = path.join(outputRoot, 'manifest.json');
  const stdoutTarget = options.stdout || process.stdout;
  const stderrTarget = options.stderr || process.stderr;
  const logger = createLogger(logPath, stdoutTarget);
  const previousTraceSummary = process.env.SIFTKIT_TRACE_SUMMARY;
  const manifest: JsonObject = {
    ok: false,
    fixtureIndex: fixtureStartIndex,
    fixtureStartIndex,
    fixtureEndIndex,
    fixtureCount: 0,
    fixtureRoot,
    sourcePath: '',
    fixtureName: '',
    backend: '',
    model: '',
    requestTimeoutSeconds: args.requestTimeoutSeconds,
    rawReviewRequired: false,
    chunkThreshold: 0,
    effectivePromptLimit: 0,
    chunkCount: 0,
    malformedChunk: null,
    chunks: [],
    malformedFixture: null,
    fixtures: [],
  };

  if (args.traceSummary) {
    process.env.SIFTKIT_TRACE_SUMMARY = '1';
  }

  let lock: { token: string } | null = null;
  try {
    const workItems = resolveWorkItems(fixtureRoot, fixtureStartIndex, fixtureEndIndex);
    const config = await loadConfig({ ensure: true });
    const backend = config.Backend;
    const model = getConfiguredModel(config);
    if (backend !== 'llama.cpp') {
      throw new Error(`This repro script requires backend=llama.cpp. Current backend: ${backend}.`);
    }
    const promptPrefix = getConfiguredPromptPrefix(config);
    manifest.backend = backend;
    manifest.model = model;
    manifest.fixtureCount = workItems.length;
    fs.mkdirSync(outputRoot, { recursive: true });
    writeJson(manifestPath, manifest);
    logger.log(`Output root: ${outputRoot}`);
    logger.log(`Fixture range: ${fixtureStartIndex}-${fixtureEndIndex}`);
    logger.log(`Fixture count: ${workItems.length}`);
    lock = await acquireExecutionLock();

    for (const workItem of workItems) {
      const fixtureManifest = buildFixtureManifest(workItem, backend, model, args.requestTimeoutSeconds);
      const fixtureOutputRoot = path.join(outputRoot, 'fixtures', `fixture-${String(workItem.fixtureIndex).padStart(2, '0')}`);
      const fixtureManifestPath = path.join(fixtureOutputRoot, 'manifest.json');
      const riskLevel = workItem.fixture.PolicyProfile === 'risky-operation' ? 'risky' : 'informational';
      const decision = getSummaryDecision(workItem.inputText, workItem.fixture.Question, riskLevel, config);
      const chunkThreshold = getLlamaCppChunkThresholdCharacters(config);
      const effectivePromptLimit = getConfiguredLlamaNumCtx(config) - getLlamaCppPromptTokenReserve(config);
      const chunks = workItem.inputText.length > chunkThreshold
        ? (await planTokenAwareLlamaCppChunks({
          question: workItem.fixture.Question,
          inputText: workItem.inputText,
          format: workItem.fixture.Format,
          policyProfile: workItem.fixture.PolicyProfile,
          rawReviewRequired: decision.RawReviewRequired,
          promptPrefix,
          sourceKind: 'standalone',
          config,
          chunkThreshold,
          phase: 'leaf',
          chunkContext: {
            isGeneratedChunk: true,
            mayBeTruncated: true,
            retryMode: 'default',
            chunkPath: null,
          },
        }) ?? splitTextIntoChunks(workItem.inputText, chunkThreshold))
        : [workItem.inputText];

      fixtureManifest.rawReviewRequired = decision.RawReviewRequired;
      fixtureManifest.chunkThreshold = chunkThreshold;
      fixtureManifest.effectivePromptLimit = effectivePromptLimit;
      fixtureManifest.chunkCount = chunks.length;
      manifest.fixtures.push(fixtureManifest);
      mirrorFixtureSummary(manifest, fixtureManifest);
      writeJson(fixtureManifestPath, fixtureManifest);
      writeJson(manifestPath, manifest);
      logger.log(`Fixture ${workItem.fixtureIndex}/${fixtureEndIndex}: ${workItem.fixture.Name}`);
      logger.log(`Source path: ${workItem.sourcePath}`);
      logger.log(`Input chars: ${workItem.inputText.length}`);
      logger.log(`Chunk threshold: ${chunkThreshold}`);
      logger.log(`Chunk count: ${chunks.length}`);

      for (let index = 0; index < chunks.length; index += 1) {
        const chunkIndex = index + 1;
        const chunkPath = `${chunkIndex}/${chunks.length}`;
        const chunkRoot = path.join(fixtureOutputRoot, 'chunks', `chunk-${String(chunkIndex).padStart(2, '0')}`);
        const promptPath = path.join(chunkRoot, 'prompt.txt');
        const responsePath = path.join(chunkRoot, 'response.txt');
        const chunkManifestPath = path.join(chunkRoot, 'chunk.json');
        const prompt = buildPrompt({
          question: workItem.fixture.Question,
          inputText: chunks[index],
          format: workItem.fixture.Format,
          policyProfile: workItem.fixture.PolicyProfile,
          rawReviewRequired: decision.RawReviewRequired,
          promptPrefix,
          sourceKind: 'standalone',
          phase: 'leaf',
          chunkContext: {
            isGeneratedChunk: true,
            mayBeTruncated: true,
            retryMode: 'default',
            chunkPath,
          },
        });
        const promptTokenCount = await countLlamaCppTokens(config, prompt);
        const response = await generateLlamaCppResponse({
          config,
          model,
          prompt,
          timeoutSeconds: args.requestTimeoutSeconds,
        });
        fs.mkdirSync(chunkRoot, { recursive: true });
        fs.writeFileSync(promptPath, prompt, 'utf8');
        fs.writeFileSync(responsePath, response.text, 'utf8');
        const chunkRecord: JsonObject = {
          index: chunkIndex,
          chunkPath,
          inputCharacters: chunks[index].length,
          promptCharacters: prompt.length,
          promptTokens: promptTokenCount,
          outputCharacters: response.text.length,
          outputTokens: response.usage?.completionTokens ?? null,
          promptPath,
          responsePath,
          parsed: false,
          classification: null,
          rawReviewRequired: null,
          outputPreview: null,
          error: null,
        };

        try {
          const parsedDecision = ModelJson.parseSummaryDecision(response.text);
          chunkRecord.parsed = true;
          chunkRecord.classification = parsedDecision.classification;
          chunkRecord.rawReviewRequired = parsedDecision.rawReviewRequired;
          chunkRecord.outputPreview = parsedDecision.output.slice(0, 500);
          logger.log(
            `Fixture ${workItem.fixtureIndex} chunk ${chunkPath} parsed prompt_tokens=${promptTokenCount ?? 'null'} `
            + `output_tokens=${chunkRecord.outputTokens ?? 'null'}`,
          );
        } catch (error) {
          const message = getErrorMessage(error);
          chunkRecord.error = message;
          fixtureManifest.malformedChunk = {
            index: chunkIndex,
            chunkPath,
            promptPath,
            responsePath,
            error: message,
          };
          fixtureManifest.chunks.push(chunkRecord);
          manifest.malformedFixture = {
            fixtureIndex: workItem.fixtureIndex,
            fixtureName: workItem.fixture.Name,
            sourcePath: workItem.sourcePath,
            chunkPath,
            error: message,
          };
          mirrorFixtureSummary(manifest, fixtureManifest);
          writeJson(chunkManifestPath, chunkRecord);
          writeJson(fixtureManifestPath, fixtureManifest);
          writeJson(manifestPath, manifest);
          logger.log(`Fixture ${workItem.fixtureIndex} chunk ${chunkPath} malformed: ${message}`);
          stderrTarget.write(`${message}\n`);
          return { exitCode: 1, manifestPath, manifest };
        }

        fixtureManifest.chunks.push(chunkRecord);
        mirrorFixtureSummary(manifest, fixtureManifest);
        writeJson(chunkManifestPath, chunkRecord);
        writeJson(fixtureManifestPath, fixtureManifest);
        writeJson(manifestPath, manifest);
      }

      fixtureManifest.ok = true;
      mirrorFixtureSummary(manifest, fixtureManifest);
      writeJson(fixtureManifestPath, fixtureManifest);
      writeJson(manifestPath, manifest);
    }

    manifest.ok = true;
    writeJson(manifestPath, manifest);
    logger.log('Completed without malformed chunk payloads.');
    return { exitCode: 0, manifestPath, manifest };
  } catch (error) {
    const message = getErrorMessage(error);
    manifest.error = message;
    writeJson(manifestPath, manifest);
    stderrTarget.write(`${message}\n`);
    return { exitCode: 1, manifestPath, manifest };
  } finally {
    if (lock) {
      try {
        await releaseExecutionLock(lock);
      } catch (error) {
        const message = getErrorMessage(error);
        manifest.lockReleaseError = message;
        if (fs.existsSync(path.dirname(manifestPath))) {
          writeJson(manifestPath, manifest);
        }
        logger.log(`Lock release warning: ${message}`);
        stderrTarget.write(`Warning: ${message}\n`);
      }
    }

    if (previousTraceSummary === undefined) {
      delete process.env.SIFTKIT_TRACE_SUMMARY;
    } else {
      process.env.SIFTKIT_TRACE_SUMMARY = previousTraceSummary;
    }
  }
}

async function main(): Promise<void> {
  const result = await runFixture60MalformedJsonRepro(process.argv.slice(2));
  process.exit(result.exitCode);
}

if (require.main === module) {
  void main().catch((error) => {
    process.stderr.write(`${getErrorMessage(error)}\n`);
    process.exit(1);
  });
}
