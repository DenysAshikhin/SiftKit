const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const fs = require('node:fs');

const {
  loadConfig,
  getConfiguredModel,
  getConfiguredPromptPrefix,
  getConfiguredLlamaBaseUrl,
  getConfiguredLlamaNumCtx,
  notifyStatusBackend,
} = require('../../dist/config/index.js');
const { getProcessedPromptTokens } = require('../../dist/lib/provider-helpers.js');
const {
  acquireExecutionLock,
  releaseExecutionLock,
} = require('../../dist/execution-lock.js');
const {
  countLlamaCppTokens,
  generateLlamaCppResponse,
} = require('../../dist/providers/llama-cpp.js');
const { getSummaryDecision } = require('../../dist/summary/decision.js');
const { buildCompactPrompt, buildPrompt } = require('../../dist/summary/prompt.js');
const { parseStructuredModelDecision, normalizeStructuredDecision } = require('../../dist/summary/structured.js');
const {
  allocateLlamaCppSlotId,
  getLlamaCppChunkThresholdCharacters,
  getPlannerPromptBudget,
} = require('../../dist/summary/chunking.js');
const {
  finalizePlannerDebugDump,
  writeSummaryRequestDump,
  clearSummaryArtifactState,
} = require('../../dist/summary/artifacts.js');

function nowMs() {
  return performance.now();
}

async function measureStep(steps, name, fn) {
  const startedAt = nowMs();
  const result = await fn();
  const endedAt = nowMs();
  steps.push({
    name,
    durationMs: Number((endedAt - startedAt).toFixed(3)),
  });
  return result;
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    throw new Error('Usage: node tmp/summary-live-tests/exact-summary-breakdown.js <input-file>');
  }

  const inputText = fs.readFileSync(inputPath, 'utf8');
  const requestId = randomUUID();
  const question = 'Extract the DECISIVE_FINDING in one short sentence.';
  const format = 'text';
  const policyProfile = 'general';
  const steps = [];
  const requestStartedAt = nowMs();

  const lock = await measureStep(steps, 'acquireExecutionLock', () => acquireExecutionLock());
  let terminalStatusPosted = false;
  let released = false;
  try {
    const config = await measureStep(steps, 'loadConfig', () => loadConfig({ ensure: true }));
    await measureStep(steps, 'getConfiguredLlamaBaseUrl', async () => {
      getConfiguredLlamaBaseUrl(config);
    });
    await measureStep(steps, 'getConfiguredLlamaNumCtx', async () => {
      getConfiguredLlamaNumCtx(config);
    });
    const backend = config.Backend;
    const model = getConfiguredModel(config);
    const decision = await measureStep(steps, 'getSummaryDecision', async () => {
      return getSummaryDecision(inputText, question, 'informational', config, {
        sourceKind: 'standalone',
        commandExitCode: undefined,
      });
    });
    const promptPrefix = getConfiguredPromptPrefix(config);
    const chunkThreshold = await measureStep(steps, 'getLlamaCppChunkThresholdCharacters', async () => {
      return getLlamaCppChunkThresholdCharacters(config);
    });
    const plannerPromptBudget = await measureStep(steps, 'getPlannerPromptBudget', async () => {
      return getPlannerPromptBudget(config);
    });
    const useCompactPrompt = backend === 'llama.cpp'
      && policyProfile === 'general'
      && inputText.length <= chunkThreshold;
    const prompt = await measureStep(steps, useCompactPrompt ? 'buildCompactPrompt' : 'buildPrompt', async () => {
      if (useCompactPrompt) {
        return buildCompactPrompt({
          question,
          inputText,
          promptPrefix,
        });
      }
      return buildPrompt({
        question,
        inputText,
        format,
        policyProfile,
        rawReviewRequired: decision.RawReviewRequired,
        promptPrefix,
        sourceKind: 'standalone',
        commandExitCode: undefined,
        phase: 'leaf',
        chunkContext: undefined,
        allowUnsupportedInput: false,
      });
    });
    const promptTokenCount = await measureStep(steps, 'countLlamaCppTokens(preflight prompt)', async () => {
      const effectivePromptLimit = plannerPromptBudget?.usablePromptBudgetTokens ?? 0;
      if (backend === 'llama.cpp' && effectivePromptLimit > 0) {
        return countLlamaCppTokens(config, prompt);
      }
      return null;
    });
    const slotId = await measureStep(steps, 'allocateLlamaCppSlotId', async () => {
      return backend === 'llama.cpp' ? allocateLlamaCppSlotId(config) : null;
    });
    await measureStep(steps, 'notifyStatusBackend(running=true)', async () => {
      await notifyStatusBackend({
        running: true,
        taskKind: 'summary',
        requestId,
        promptCharacterCount: prompt.length,
        promptTokenCount,
        rawInputCharacterCount: inputText.length,
        chunkInputCharacterCount: inputText.length,
        phase: 'leaf',
      });
    });
    const providerResponse = await measureStep(steps, 'generateLlamaCppResponse', async () => {
      return generateLlamaCppResponse({
        config,
        model,
        prompt,
        promptTokenCount,
        timeoutSeconds: 600,
        slotId: slotId ?? undefined,
        structuredOutput: {
          kind: 'siftkit-decision-json',
          allowUnsupportedInput: false,
        },
        overrides: undefined,
      });
    });
    const inputTokens = await measureStep(steps, 'getProcessedPromptTokens', async () => {
      return getProcessedPromptTokens(
        providerResponse.usage?.promptTokens ?? null,
        providerResponse.usage?.promptCacheTokens ?? null,
        providerResponse.usage?.promptEvalTokens ?? null,
      );
    });
    await measureStep(steps, 'notifyStatusBackend(running=false provider)', async () => {
      await notifyStatusBackend({
        running: false,
        taskKind: 'summary',
        requestId,
        promptCharacterCount: prompt.length,
        inputTokens,
        outputCharacterCount: providerResponse.text.length,
        outputTokens: providerResponse.usage?.completionTokens ?? null,
        thinkingTokens: providerResponse.usage?.thinkingTokens ?? null,
        promptCacheTokens: providerResponse.usage?.promptCacheTokens ?? null,
        promptEvalTokens: providerResponse.usage?.promptEvalTokens ?? null,
        requestDurationMs: null,
      });
    });
    const rawResponse = providerResponse.text.trim();
    const parsedDecision = await measureStep(steps, 'parseStructuredModelDecision', async () => {
      return parseStructuredModelDecision(rawResponse);
    });
    const normalizedDecision = await measureStep(steps, 'normalizeStructuredDecision', async () => {
      return normalizeStructuredDecision(parsedDecision, format);
    });
    await measureStep(steps, 'notifyStatusBackend(terminal completed)', async () => {
      await notifyStatusBackend({
        running: false,
        taskKind: 'summary',
        requestId,
        terminalState: 'completed',
        rawInputCharacterCount: inputText.length,
      });
      terminalStatusPosted = true;
    });
    await measureStep(steps, 'finalizePlannerDebugDump', async () => {
      await finalizePlannerDebugDump({
        requestId,
        finalOutput: normalizedDecision.output.trim(),
        classification: normalizedDecision.classification,
        rawReviewRequired: normalizedDecision.rawReviewRequired,
        providerError: null,
      });
    });
    await measureStep(steps, 'writeSummaryRequestDump', async () => {
      await writeSummaryRequestDump({
        requestId,
        question,
        inputText,
        command: null,
        backend,
        model,
        classification: normalizedDecision.classification,
        rawReviewRequired: normalizedDecision.rawReviewRequired,
        summary: normalizedDecision.output.trim(),
        providerError: null,
        error: null,
      });
    });
    await measureStep(steps, 'clearSummaryArtifactState', async () => {
      clearSummaryArtifactState(requestId);
    });
    const totalMsBeforeRelease = Number((nowMs() - requestStartedAt).toFixed(3));
    await measureStep(steps, 'releaseExecutionLock', async () => {
      await releaseExecutionLock(lock);
    });
    released = true;
    const totalMs = Number((nowMs() - requestStartedAt).toFixed(3));
    process.stdout.write(`${JSON.stringify({
      requestId,
      backend,
      model,
      inputChars: inputText.length,
      output: normalizedDecision.output.trim(),
      totalMsBeforeRelease,
      totalMs,
      steps,
    }, null, 2)}\n`);
  } catch (error) {
    if (!terminalStatusPosted) {
      try {
        await notifyStatusBackend({
          running: false,
          taskKind: 'summary',
          requestId,
          terminalState: 'failed',
          errorMessage: error instanceof Error ? error.message : String(error),
          rawInputCharacterCount: inputText.length,
        });
      } catch {}
    }
    throw error;
  } finally {
    if (!released) {
      try {
        await releaseExecutionLock(lock);
      } catch {}
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
