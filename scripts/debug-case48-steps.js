#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const {
  loadConfig,
  getChunkThresholdCharacters,
  getConfiguredLlamaNumCtx,
  getConfiguredModel,
  getConfiguredPromptPrefix,
} = require('../dist/config.js');
const { acquireExecutionLock, releaseExecutionLock } = require('../dist/execution-lock.js');
const { buildPrompt } = require('../dist/summary.js');
const { countLlamaCppTokens, generateLlamaCppResponse } = require('../dist/providers/llama-cpp.js');

const LLAMA_CPP_PROMPT_TOKEN_RESERVE = 1024;
const LLAMA_CPP_PROMPT_TOKEN_TARGET_TOLERANCE = 2000;
const MAX_TOKEN_AWARE_CHUNK_ADJUSTMENTS = 8;

function parseArgs(argv) {
  const parsed = {
    fixtureIndex: 48,
    stepTimeoutSeconds: 30,
    requestTimeoutSeconds: 30,
    skipProvider: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case '--fixture-index':
        parsed.fixtureIndex = Number(argv[++index]);
        break;
      case '--step-timeout-seconds':
        parsed.stepTimeoutSeconds = Number(argv[++index]);
        break;
      case '--request-timeout-seconds':
        parsed.requestTimeoutSeconds = Number(argv[++index]);
        break;
      case '--skip-provider':
        parsed.skipProvider = true;
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  if (!Number.isInteger(parsed.fixtureIndex) || parsed.fixtureIndex <= 0) {
    throw new Error('fixture-index must be a positive integer.');
  }
  if (!Number.isFinite(parsed.stepTimeoutSeconds) || parsed.stepTimeoutSeconds <= 0) {
    throw new Error('step-timeout-seconds must be a positive number.');
  }
  if (!Number.isFinite(parsed.requestTimeoutSeconds) || parsed.requestTimeoutSeconds <= 0) {
    throw new Error('request-timeout-seconds must be a positive number.');
  }

  return parsed;
}

function getTimestamp() {
  const current = new Date();
  const yyyy = current.getFullYear();
  const MM = String(current.getMonth() + 1).padStart(2, '0');
  const dd = String(current.getDate()).padStart(2, '0');
  const hh = String(current.getHours()).padStart(2, '0');
  const mm = String(current.getMinutes()).padStart(2, '0');
  const ss = String(current.getSeconds()).padStart(2, '0');
  return `${yyyy}${MM}${dd}_${hh}${mm}${ss}`;
}

function formatDurationMs(durationMs) {
  if (durationMs < 1000) {
    return `${durationMs.toFixed(1)}ms`;
  }

  return `${(durationMs / 1000).toFixed(3)}s`;
}

function createLogger(logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, '', 'utf8');

  return (message) => {
    const line = `[${new Date().toISOString()}] ${message}`;
    process.stdout.write(`${line}\n`);
    fs.appendFileSync(logPath, `${line}\n`, 'utf8');
  };
}

function withDeadline(label, timeoutMs, operation) {
  return new Promise((resolve, reject) => {
    const startedAt = process.hrtime.bigint();
    let settled = false;
    const timeoutHandle = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error(`${label} exceeded ${timeoutMs}ms.`));
    }, timeoutMs);

    Promise.resolve()
      .then(operation)
      .then((value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);
        resolve({
          value,
          durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
        });
      })
      .catch((error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);
        reject(error);
      });
  });
}

function getTokenAwareChunkThreshold(inputLength, promptTokenCount, effectivePromptLimit) {
  if (
    inputLength <= 1
    || promptTokenCount <= effectivePromptLimit
    || effectivePromptLimit <= 0
  ) {
    return null;
  }

  const scaledThreshold = Math.floor(
    inputLength * (effectivePromptLimit / promptTokenCount) * 0.95
  );
  const reducedThreshold = Math.max(1, Math.min(inputLength - 1, scaledThreshold));
  return reducedThreshold < inputLength ? reducedThreshold : null;
}

function stripCodeFence(text) {
  const trimmed = String(text || '').trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

function tryParseDecision(text) {
  try {
    return JSON.parse(stripCodeFence(text));
  } catch {
    return null;
  }
}

async function timedStep(log, label, timeoutMs, operation) {
  log(`START ${label}`);
  const result = await withDeadline(label, timeoutMs, operation);
  log(`DONE  ${label} in ${formatDurationMs(result.durationMs)}`);
  return result.value;
}

async function countPromptTokens(log, options) {
  const prompt = buildPrompt({
    question: options.fixture.Question,
    inputText: options.inputText,
    format: options.fixture.Format,
    policyProfile: options.fixture.PolicyProfile,
    rawReviewRequired: false,
    promptPrefix: options.promptPrefix,
    sourceKind: 'standalone',
    phase: options.phase,
    chunkContext: options.chunkContext,
  });

  const tokenCount = await timedStep(
    log,
    `tokenize prompt ${options.label} chars=${prompt.length}`,
    options.timeoutMs,
    () => countLlamaCppTokens(options.config, prompt)
  );

  return {
    prompt,
    tokenCount,
  };
}

async function inspectChunkPlanning(log, options) {
  const chunks = [];
  const effectivePromptLimit = options.effectivePromptLimit;
  let offset = 0;

  while (offset < options.inputText.length) {
    const remainingLength = options.inputText.length - offset;
    const targetSlackTokens = Math.min(LLAMA_CPP_PROMPT_TOKEN_TARGET_TOLERANCE, effectivePromptLimit);
    let candidateLength = Math.min(options.chunkThreshold, remainingLength);
    let acceptedChunk = null;
    let acceptedLength = 0;
    let rejectedLength = null;
    let adjustmentCount = 0;

    log(`PLAN chunk offset=${offset} remaining=${remainingLength} initialCandidate=${candidateLength}`);

    while (candidateLength > 0 && adjustmentCount < MAX_TOKEN_AWARE_CHUNK_ADJUSTMENTS) {
      adjustmentCount += 1;
      const candidateText = options.inputText.substring(offset, offset + candidateLength);
      const chunkPath = `${chunks.length + 1}/?`;
      const { tokenCount, prompt } = await countPromptTokens(log, {
        config: options.config,
        fixture: options.fixture,
        inputText: candidateText,
        promptPrefix: options.promptPrefix,
        phase: 'leaf',
        chunkContext: {
          isGeneratedChunk: true,
          mayBeTruncated: true,
          retryMode: 'default',
          chunkPath,
        },
        label: `chunkCandidate offset=${offset} len=${candidateLength} attempt=${adjustmentCount}`,
        timeoutMs: options.timeoutMs,
      });

      log(
        `INFO  chunkCandidate offset=${offset} len=${candidateLength} attempt=${adjustmentCount} `
        + `promptChars=${prompt.length} promptTokens=${tokenCount === null ? 'null' : tokenCount}`
      );

      if (tokenCount === null) {
        throw new Error(`Token count returned null for offset=${offset} len=${candidateLength}.`);
      }

      if (tokenCount <= effectivePromptLimit) {
        acceptedChunk = candidateText;
        acceptedLength = candidateLength;
        const slackTokens = effectivePromptLimit - tokenCount;
        if (
          slackTokens <= targetSlackTokens
          || candidateLength >= remainingLength
          || rejectedLength === acceptedLength + 1
        ) {
          break;
        }

        if (rejectedLength !== null) {
          candidateLength = Math.max(
            acceptedLength + 1,
            Math.floor((acceptedLength + rejectedLength) / 2)
          );
          continue;
        }

        const grownLength = Math.min(
          remainingLength,
          Math.max(
            acceptedLength + 1,
            Math.floor(acceptedLength * (effectivePromptLimit / Math.max(tokenCount, 1)))
          )
        );
        if (grownLength <= acceptedLength) {
          break;
        }
        candidateLength = grownLength;
        continue;
      }

      rejectedLength = candidateLength;
      if (acceptedLength > 0) {
        candidateLength = Math.max(
          acceptedLength + 1,
          Math.floor((acceptedLength + rejectedLength) / 2)
        );
        continue;
      }

      const reducedLength = getTokenAwareChunkThreshold(candidateLength, tokenCount, effectivePromptLimit);
      if (reducedLength === null || reducedLength >= candidateLength) {
        throw new Error(
          `Unable to shrink chunk at offset=${offset}; candidateLength=${candidateLength} promptTokens=${tokenCount}.`
        );
      }

      candidateLength = reducedLength;
    }

    if (!acceptedChunk) {
      throw new Error(`No acceptable chunk found at offset=${offset}.`);
    }

    chunks.push(acceptedChunk);
    log(`ACCEPT chunk index=${chunks.length} offset=${offset} len=${acceptedChunk.length}`);
    offset += acceptedChunk.length;
  }

  return chunks;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(__dirname, '..');
  const fixtureRoot = path.join(repoRoot, 'eval', 'fixtures', 'ai_core_60_tests');
  const manifestPath = path.join(fixtureRoot, 'fixtures.json');
  const logPath = path.join(repoRoot, 'tmp-find', `case${args.fixtureIndex}_step_trace_${getTimestamp()}.log`);
  const log = createLogger(logPath);
  const timeoutMs = args.stepTimeoutSeconds * 1000;

  log(`Trace log: ${logPath}`);
  log(`Fixture index: ${args.fixtureIndex}`);
  log(`Per-step timeout: ${args.stepTimeoutSeconds}s`);

  let lock = null;
  try {
    const config = await timedStep(log, 'load config', timeoutMs, () => loadConfig({ ensure: true }));
    const manifest = await timedStep(log, 'read fixture manifest', timeoutMs, () => JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
    const fixture = manifest[args.fixtureIndex - 1];
    if (!fixture) {
      throw new Error(`Fixture ${args.fixtureIndex} not found in ${manifestPath}.`);
    }

    const fixturePath = path.join(fixtureRoot, fixture.File);
    const inputText = await timedStep(log, `read fixture input ${path.basename(fixturePath)}`, timeoutMs, () => fs.readFileSync(fixturePath, 'utf8'));
    const model = getConfiguredModel(config);
    const promptPrefix = getConfiguredPromptPrefix(config);
    const chunkThreshold = getChunkThresholdCharacters(config);
    const effectivePromptLimit = getConfiguredLlamaNumCtx(config) - LLAMA_CPP_PROMPT_TOKEN_RESERVE;

    log(`Fixture name: ${fixture.Name}`);
    log(`Fixture file: ${fixturePath}`);
    log(`Input chars: ${inputText.length}`);
    log(`Model: ${model}`);
    log(`Chunk threshold chars: ${chunkThreshold}`);
    log(`Effective prompt limit tokens: ${effectivePromptLimit}`);

    lock = await timedStep(log, 'acquire execution lock', timeoutMs, () => acquireExecutionLock());
    log(`Execution lock token: ${lock.token}`);

    const fullPrompt = await timedStep(
      log,
      'build full prompt',
      timeoutMs,
      () => buildPrompt({
        question: fixture.Question,
        inputText,
        format: fixture.Format,
        policyProfile: fixture.PolicyProfile,
        rawReviewRequired: false,
        promptPrefix,
        sourceKind: 'standalone',
        phase: 'leaf',
      })
    );
    log(`Full prompt chars: ${fullPrompt.length}`);

    const fullPromptTokens = await timedStep(
      log,
      'tokenize full prompt',
      timeoutMs,
      () => countLlamaCppTokens(config, fullPrompt)
    );
    log(`Full prompt tokens: ${fullPromptTokens === null ? 'null' : fullPromptTokens}`);

    log('START inspect token-aware chunk planning');
    const chunkPlanStartedAt = process.hrtime.bigint();
    const chunks = await inspectChunkPlanning(log, {
      config,
      fixture,
      inputText,
      promptPrefix,
      chunkThreshold,
      effectivePromptLimit,
      timeoutMs,
    });
    log(`DONE  inspect token-aware chunk planning in ${formatDurationMs(Number(process.hrtime.bigint() - chunkPlanStartedAt) / 1_000_000)}`);
    log(`Planned chunks: ${chunks.length}`);

    if (args.skipProvider) {
      log('Skipping provider requests by flag.');
      return;
    }

    const chunkResponses = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const chunkPrompt = await timedStep(
        log,
        `build chunk ${index + 1} prompt`,
        timeoutMs,
        () => buildPrompt({
          question: fixture.Question,
          inputText: chunks[index],
          format: fixture.Format,
          policyProfile: fixture.PolicyProfile,
          rawReviewRequired: false,
          promptPrefix,
          sourceKind: 'standalone',
          phase: 'leaf',
          chunkContext: {
            isGeneratedChunk: true,
            mayBeTruncated: true,
            retryMode: 'default',
            chunkPath: `${index + 1}/${chunks.length}`,
          },
        })
      );
      log(`Chunk ${index + 1} prompt chars: ${chunkPrompt.length}`);

      const chunkResponse = await timedStep(
        log,
        `provider chunk ${index + 1}/${chunks.length} request`,
        timeoutMs,
        () => generateLlamaCppResponse({
          config,
          model,
          prompt: chunkPrompt,
          timeoutSeconds: args.requestTimeoutSeconds,
        })
      );

      const parsedDecision = tryParseDecision(chunkResponse.text);
      log(`Chunk ${index + 1} output chars: ${chunkResponse.text.length}`);
      log(`Chunk ${index + 1} prompt tokens: ${chunkResponse.usage?.promptTokens ?? 'null'}`);
      log(`Chunk ${index + 1} completion tokens: ${chunkResponse.usage?.completionTokens ?? 'null'}`);
      log(`Chunk ${index + 1} JSON parse: ${parsedDecision ? 'ok' : 'failed'}`);
      chunkResponses.push(parsedDecision ?? {
        classification: 'unparsed',
        raw_review_required: null,
        output: chunkResponse.text,
      });
    }

    const mergeInput = chunkResponses.map((decision, index) => [
      `Chunk ${index + 1}:`,
      `classification=${decision.classification}`,
      `raw_review_required=${decision.raw_review_required}`,
      decision.output,
    ].join('\n')).join('\n\n');

    const mergePrompt = await timedStep(
      log,
      'build merge prompt',
      timeoutMs,
      () => buildPrompt({
        question: `Merge these partial summaries into one final answer for the original question: ${fixture.Question}`,
        inputText: mergeInput,
        format: fixture.Format,
        policyProfile: fixture.PolicyProfile,
        rawReviewRequired: chunkResponses.some((decision) => decision.raw_review_required === true),
        promptPrefix,
        sourceKind: 'standalone',
        phase: 'merge',
      })
    );
    log(`Merge prompt chars: ${mergePrompt.length}`);

    const mergeResponse = await timedStep(
      log,
      'provider merge request',
      timeoutMs,
      () => generateLlamaCppResponse({
        config,
        model,
        prompt: mergePrompt,
        timeoutSeconds: args.requestTimeoutSeconds,
      })
    );
    log(`Merge output chars: ${mergeResponse.text.length}`);
    log(`Merge prompt tokens: ${mergeResponse.usage?.promptTokens ?? 'null'}`);
    log(`Merge completion tokens: ${mergeResponse.usage?.completionTokens ?? 'null'}`);
    log(`Merge JSON parse: ${tryParseDecision(mergeResponse.text) ? 'ok' : 'failed'}`);
  } finally {
    if (lock) {
      await timedStep(log, 'release execution lock', timeoutMs, () => releaseExecutionLock(lock));
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
