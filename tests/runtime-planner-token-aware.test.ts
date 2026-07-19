import test from 'node:test';
import assert from 'node:assert/strict';

import { asObject } from './helpers/dashboard-http.js';
import {
  fs,
  path,
  loadConfig,
  getChunkThresholdCharacters,
  getConfiguredLlamaNumCtx,
  getEffectiveInputCharactersPerContextToken,
  summarizeRequest,
  buildPrompt,
  getSummaryDecision,
  planTokenAwareLlamaCppChunks,
  getPlannerPromptBudget,
  countLlamaCppTokens,
  RUN_LIVE_LLAMA_TOKENIZE_TESTS,
  LIVE_LLAMA_BASE_URL,
  LIVE_CONFIG_SERVICE_URL,
  getDefaultConfig,
  clone,
  setManagedLlamaBaseUrl,
  requestJson,
  withTempEnv,
  withStubServer,
} from './_runtime-helpers.js';
import type { SiftConfig } from '../src/config/types.js';
import { getActiveModelPreset } from '../src/config/getters.js';
import type { SummaryPolicyProfile } from '../src/summary/types.js';

interface FixtureManifestEntry {
  File: string;
  Question: string;
  Format: 'text' | 'json';
  PolicyProfile: SummaryPolicyProfile;
}

function requireConfigServiceUrl(): string {
  const url = process.env.SIFTKIT_CONFIG_SERVICE_URL;
  if (!url) {
    throw new Error('SIFTKIT_CONFIG_SERVICE_URL is not set');
  }
  return url;
}

interface LiveConfigResponse {
  Runtime?: { LlamaCpp?: { BaseUrl?: string | null; NumCtx?: number | null } };
}

test('oversized llama.cpp summaries stay on planner status path without leaf chunk markers', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const result = await summarizeRequest({
        question: 'summarize this',
        inputText: 'A'.repeat(threshold * 2),
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(result.WasSummarized, true);
      const chunkPaths = server.state.statusPosts
        .filter((post) => (
          post.running === true
          && post.phase === 'leaf'
          && post.rawInputCharacterCount === threshold * 2
          && typeof post.chunkPath === 'string'
        ))
        .map((post) => String(post.chunkPath));
      assert.equal(chunkPaths.length, 0);
    }, {
      assistantContent() {
        return JSON.stringify({
          action: 'finish',
          classification: 'summary',
          raw_review_required: false,
          output: 'planner finish',
        });
      },
      tokenizeCharsPerToken: 1,
      metrics: {
        inputCharactersTotal: 3_461_904,
        inputTokensTotal: 1_865_267,
        outputCharactersTotal: 0,
        outputTokensTotal: 0,
        thinkingTokensTotal: 0,
        completedRequestCount: 0,
        requestDurationMsTotal: 0,
      },
    });
  });
});

test('token-aware llama.cpp chunk planning grows upward when prompt tokens leave slack', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const config = getDefaultConfig();
      setManagedLlamaBaseUrl(config, requireConfigServiceUrl().replace(/\/config$/u, ''));
      config.Runtime.LlamaCpp = {
        ...(config.Runtime.LlamaCpp || {}),
        BaseUrl: requireConfigServiceUrl().replace(/\/config$/u, ''),
        NumCtx: 20_000,
        Reasoning: 'off',
      };
      const inputText = 'A'.repeat(5_000);
      const decision = getSummaryDecision(inputText, 'summarize this', 'informational', config);
      const chunks = await planTokenAwareLlamaCppChunks({
        question: 'summarize this',
        inputText,
        format: 'text',
        policyProfile: 'general',
        rawReviewRequired: decision.RawReviewRequired,
        sourceKind: 'standalone',
        config,
        chunkThreshold: 1_000,
        phase: 'leaf',
      });

      assert.ok(chunks);
      assert.equal(chunks.length, 1);
      assert.equal(chunks[0], inputText);
    }, {
      tokenizeCharsPerToken: 10,
      metrics: {
        inputCharactersTotal: 3_461_904,
        inputTokensTotal: 1_865_267,
        outputCharactersTotal: 0,
        outputTokensTotal: 0,
        thinkingTokensTotal: 0,
        completedRequestCount: 0,
        requestDurationMsTotal: 0,
      },
    });
  });
});

test('token-aware llama.cpp chunk planning starts from the char-threshold guess before growing upward', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const config = getDefaultConfig();
      const baseUrl = requireConfigServiceUrl().replace(/\/config$/u, '');
      setManagedLlamaBaseUrl(config, baseUrl);
      config.Runtime.LlamaCpp = {
        ...(config.Runtime.LlamaCpp || {}),
        BaseUrl: baseUrl,
        NumCtx: 20_000,
        Reasoning: 'off',
      };
      const inputText = 'A'.repeat(5_000);
      const decision = getSummaryDecision(inputText, 'summarize this', 'informational', config);
      const chunkThreshold = 1_000;
      const initialPrompt = buildPrompt({
        question: 'summarize this',
        inputText: inputText.slice(0, chunkThreshold),
        format: 'text',
        policyProfile: 'general',
        rawReviewRequired: decision.RawReviewRequired,
        sourceKind: 'standalone',
        phase: 'leaf',
      });
      const chunks = await planTokenAwareLlamaCppChunks({
        question: 'summarize this',
        inputText,
        format: 'text',
        policyProfile: 'general',
        rawReviewRequired: decision.RawReviewRequired,
        sourceKind: 'standalone',
        config,
        chunkThreshold,
        phase: 'leaf',
      });

      assert.ok(chunks);
      assert.equal(server.state.tokenizeRequests[0].content, initialPrompt);
      assert.ok(chunks[0].length > chunkThreshold);
    }, {
      tokenizeCharsPerToken: 10,
      metrics: {
        inputCharactersTotal: 3_461_904,
        inputTokensTotal: 1_865_267,
        outputCharactersTotal: 0,
        outputTokensTotal: 0,
        thinkingTokensTotal: 0,
        completedRequestCount: 0,
        requestDurationMsTotal: 0,
      },
    });
  });
});

test('token-aware llama.cpp chunk planning shrinks after an overshooting growth probe and still stays above the initial guess', async () => {
  await withTempEnv(async () => {
    const previewConfig = getDefaultConfig();
    const previewInputText = 'A'.repeat(3_000);
    const previewDecision = getSummaryDecision(previewInputText, 'summarize this', 'informational', previewConfig);
    const thresholdPromptLength = buildPrompt({
      question: 'summarize this',
      inputText: previewInputText.slice(0, 1_000),
      format: 'text',
      policyProfile: 'general',
      rawReviewRequired: previewDecision.RawReviewRequired,
      sourceKind: 'standalone',
      phase: 'leaf',
    }).length;
    await withStubServer(async () => {
      const config = getDefaultConfig();
      const baseUrl = requireConfigServiceUrl().replace(/\/config$/u, '');
      setManagedLlamaBaseUrl(config, baseUrl);
      config.Runtime.LlamaCpp = {
        ...(config.Runtime.LlamaCpp || {}),
        BaseUrl: baseUrl,
        NumCtx: 12_000,
        Reasoning: 'off',
      };
      const inputText = 'A'.repeat(3_000);
      const decision = getSummaryDecision(inputText, 'summarize this', 'informational', config);
      const chunkThreshold = 1_000;
      const chunks = await planTokenAwareLlamaCppChunks({
        question: 'summarize this',
        inputText,
        format: 'text',
        policyProfile: 'general',
        rawReviewRequired: decision.RawReviewRequired,
        sourceKind: 'standalone',
        config,
        chunkThreshold,
        phase: 'leaf',
      });

      assert.ok(chunks);
      assert.equal(chunks.join(''), inputText);
      assert.ok(chunks.length >= 2);
      assert.ok(chunks[0].length >= chunkThreshold);
      assert.ok(chunks[0].length < inputText.length);
    }, {
      tokenizeTokenCount(content) {
        if (content.length <= thresholdPromptLength) {
          return 500;
        }
        if (content.length <= thresholdPromptLength + 500) {
          return 2200;
        }
        return 3300;
      },
      metrics: {
        inputCharactersTotal: 3_461_904,
        inputTokensTotal: 1_865_267,
        outputCharactersTotal: 0,
        outputTokensTotal: 0,
        thinkingTokensTotal: 0,
        completedRequestCount: 0,
        requestDurationMsTotal: 0,
      },
    });
  });
});

test('token-aware llama.cpp chunk planning keeps adjusting until accepted chunks are within 2000 tokens of the limit', async () => {
  await withTempEnv(async () => {
    const previewConfig = getDefaultConfig();
    const previewInputText = 'A'.repeat(3_000);
    const previewDecision = getSummaryDecision(previewInputText, 'summarize this', 'informational', previewConfig);
    const thresholdPrompt = buildPrompt({
      question: 'summarize this',
      inputText: previewInputText.slice(0, 1_000),
      format: 'text',
      policyProfile: 'general',
      rawReviewRequired: previewDecision.RawReviewRequired,
      sourceKind: 'standalone',
      phase: 'leaf',
    });
    await withStubServer(async () => {
      const config = getDefaultConfig();
      const baseUrl = requireConfigServiceUrl().replace(/\/config$/u, '');
      setManagedLlamaBaseUrl(config, baseUrl);
      config.Runtime.LlamaCpp = {
        ...(config.Runtime.LlamaCpp || {}),
        BaseUrl: baseUrl,
        NumCtx: 12_000,
        Reasoning: 'off',
      };
      const inputText = 'A'.repeat(3_000);
      const decision = getSummaryDecision(inputText, 'summarize this', 'informational', config);
      const chunks = await planTokenAwareLlamaCppChunks({
        question: 'summarize this',
        inputText,
        format: 'text',
        policyProfile: 'general',
        rawReviewRequired: decision.RawReviewRequired,
        sourceKind: 'standalone',
        config,
        chunkThreshold: 1_000,
        phase: 'leaf',
      });

      assert.ok(chunks);
      assert.equal(chunks.join(''), inputText);
      assert.ok(chunks.length >= 2);

      const prompt = buildPrompt({
        question: 'summarize this',
        inputText: chunks[0],
        format: 'text',
        policyProfile: 'general',
        rawReviewRequired: decision.RawReviewRequired,
        sourceKind: 'standalone',
        phase: 'leaf',
      });
      const promptTokenCount = await countLlamaCppTokens(config, prompt);
      const numCtx = config.Runtime.LlamaCpp.NumCtx;
      assert.ok(numCtx != null);
      const effectivePromptLimit = numCtx - 10000;

      assert.ok(promptTokenCount != null);
      assert.ok(promptTokenCount <= effectivePromptLimit);
      assert.ok(promptTokenCount >= effectivePromptLimit - 2000);
    }, {
      tokenizeTokenCount(content) {
        if (content.length <= thresholdPrompt.length) {
          return 1000;
        }
        return 1000 + ((content.length - thresholdPrompt.length) * 2);
      },
      metrics: {
        inputCharactersTotal: 3_461_904,
        inputTokensTotal: 1_865_267,
        outputCharactersTotal: 0,
        outputTokensTotal: 0,
        thinkingTokensTotal: 0,
        completedRequestCount: 0,
        requestDurationMsTotal: 0,
      },
    });
  });
});

test('token-aware llama.cpp chunk planning leaves a 15k token reserve when reasoning is on', async () => {
  await withTempEnv(async () => {
    const previewConfig = getDefaultConfig();
    const previewInputText = 'A'.repeat(3_000);
    const previewDecision = getSummaryDecision(previewInputText, 'summarize this', 'informational', previewConfig);
    const thresholdPrompt = buildPrompt({
      question: 'summarize this',
      inputText: previewInputText.slice(0, 1_000),
      format: 'text',
      policyProfile: 'general',
      rawReviewRequired: previewDecision.RawReviewRequired,
      sourceKind: 'standalone',
      phase: 'leaf',
    });
    await withStubServer(async () => {
      const config = getDefaultConfig();
      const baseUrl = requireConfigServiceUrl().replace(/\/config$/u, '');
      setManagedLlamaBaseUrl(config, baseUrl);
      config.Runtime.LlamaCpp = {
        ...(config.Runtime.LlamaCpp || {}),
        BaseUrl: baseUrl,
        NumCtx: 17_000,
      };
      getActiveModelPreset(config).Reasoning = 'on';
      const inputText = 'A'.repeat(3_000);
      const decision = getSummaryDecision(inputText, 'summarize this', 'informational', config);
      const chunks = await planTokenAwareLlamaCppChunks({
        question: 'summarize this',
        inputText,
        format: 'text',
        policyProfile: 'general',
        rawReviewRequired: decision.RawReviewRequired,
        sourceKind: 'standalone',
        config,
        chunkThreshold: 1_000,
        phase: 'leaf',
      });

      assert.ok(chunks);
      assert.equal(chunks.join(''), inputText);
      assert.ok(chunks.length >= 2);

      const prompt = buildPrompt({
        question: 'summarize this',
        inputText: chunks[0],
        format: 'text',
        policyProfile: 'general',
        rawReviewRequired: decision.RawReviewRequired,
        sourceKind: 'standalone',
        phase: 'leaf',
      });
      const promptTokenCount = await countLlamaCppTokens(config, prompt);
      const numCtx = config.Runtime.LlamaCpp.NumCtx;
      assert.ok(numCtx != null);
      const effectivePromptLimit = numCtx - 15000;

      assert.ok(promptTokenCount != null);
      assert.ok(promptTokenCount <= effectivePromptLimit);
      assert.ok(promptTokenCount >= effectivePromptLimit - 2000);
    }, {
      tokenizeTokenCount(content) {
        if (content.length <= thresholdPrompt.length) {
          return 1000;
        }
        return 1000 + ((content.length - thresholdPrompt.length) * 4);
      },
      metrics: {
        inputCharactersTotal: 3_461_904,
        inputTokensTotal: 1_865_267,
        outputCharactersTotal: 0,
        outputTokensTotal: 0,
        thinkingTokensTotal: 0,
        completedRequestCount: 0,
        requestDurationMsTotal: 0,
      },
    });
  });
});

// eval/fixtures/ai_core_60_tests is gitignored benchmark data, absent on a
// fresh clone. Skip rather than fail when the manifest is not present locally.
const aiCore60FixtureManifestPresent = fs.existsSync(
  path.resolve(__dirname, '..', 'eval', 'fixtures', 'ai_core_60_tests', 'fixtures.json'),
);
test('live llama token-aware chunk planning preserves the 5m benchmark fixture without chat completion', {
  skip: aiCore60FixtureManifestPresent ? false : 'eval/fixtures/ai_core_60_tests is gitignored and not present locally',
}, async () => {
  const runFixtureCheck = async (config: SiftConfig) => {
  const fixtureRoot = path.resolve(__dirname, '..', 'eval', 'fixtures', 'ai_core_60_tests');
  const manifest: FixtureManifestEntry[] = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'fixtures.json'), 'utf8'));
  const fixture = manifest.find((entry) => entry.File === 'raw/19_script_error_and_crash_marker_scan.txt');
  assert.ok(fixture, 'Fixture 19 must exist in eval/fixtures/ai_core_60_tests/fixtures.json.');

  const inputPath = path.join(fixtureRoot, ...fixture.File.split('/'));
  const inputText = fs.readFileSync(inputPath, 'utf8');

  const riskLevel = fixture.PolicyProfile === 'risky-operation' ? 'risky' : 'informational';
  const decision = getSummaryDecision(inputText, fixture.Question, riskLevel, config);
  const chunkThreshold = getChunkThresholdCharacters(config);
  const chunks = await planTokenAwareLlamaCppChunks({
    question: fixture.Question,
    inputText,
    format: fixture.Format,
    policyProfile: fixture.PolicyProfile,
    rawReviewRequired: decision.RawReviewRequired,
    sourceKind: 'standalone',
    config,
    chunkThreshold,
    phase: 'leaf',
  });

  assert.ok(chunks, 'Live llama tokenization must succeed for the chunk-planning test.');
  assert.ok(chunks.length > 1, 'Fixture 19 should split into multiple chunks.');
  assert.equal(chunks.join(''), inputText);
  assert.equal(chunks.reduce((total, chunk) => total + chunk.length, 0), inputText.length);
  assert.ok(chunks.every((chunk) => chunk.length > 0));
  assert.ok(chunks.some((chunk) => chunk.length > chunkThreshold));

  const activePreset = getActiveModelPreset(config);
  const promptReserve = activePreset.Reasoning === 'off' ? 10000 : 15000;
  const numCtx = activePreset.NumCtx;
  assert.ok(numCtx != null);
  const effectivePromptLimit = numCtx - promptReserve;
  for (const chunk of chunks) {
    const prompt = buildPrompt({
      question: fixture.Question,
      inputText: chunk,
      format: fixture.Format,
      policyProfile: fixture.PolicyProfile,
      rawReviewRequired: decision.RawReviewRequired,
      sourceKind: 'standalone',
      phase: 'leaf',
    });
    const promptTokenCount = await countLlamaCppTokens(config, prompt);
    assert.ok(promptTokenCount != null, 'Each chunk prompt must be token-countable.');
    assert.ok(promptTokenCount <= effectivePromptLimit, `Chunk prompt token count ${promptTokenCount} exceeded ${effectivePromptLimit}.`);
  }
  };

  if (RUN_LIVE_LLAMA_TOKENIZE_TESTS) {
    let liveConfig: LiveConfigResponse | null = null;
    try {
      liveConfig = await requestJson<LiveConfigResponse>(LIVE_CONFIG_SERVICE_URL);
    } catch {
      liveConfig = null;
    }
    const config = getDefaultConfig();
    const liveBaseUrl = liveConfig?.Runtime?.LlamaCpp?.BaseUrl || LIVE_LLAMA_BASE_URL;
    const liveNumCtx = Number(liveConfig?.Runtime?.LlamaCpp?.NumCtx) || getActiveModelPreset(config).NumCtx;
    setManagedLlamaBaseUrl(config, liveBaseUrl);
    config.Runtime.LlamaCpp = {
      ...(config.Runtime.LlamaCpp || {}),
      BaseUrl: liveBaseUrl,
      NumCtx: liveNumCtx,
    };
    getActiveModelPreset(config).NumCtx = liveNumCtx;
    await runFixtureCheck(config);
    return;
  }

  await withTempEnv(async () => {
    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });
      await runFixtureCheck(config);
    }, {
      tokenizeTokenCount(content) {
        return Math.max(1, Math.ceil(String(content || '').length / 4));
      },
    });
  });
});

test('getPlannerPromptBudget leaves 27k headroom for a 190k non-thinking context', () => {
  const config = getDefaultConfig();
  config.Runtime.LlamaCpp.NumCtx = 190000;
  getActiveModelPreset(config).Reasoning = 'off';

  const budget = getPlannerPromptBudget(config);
  assert.deepEqual(budget, {
    numCtxTokens: 190000,
    promptReserveTokens: 10000,
    usablePromptBudgetTokens: 180000,
    plannerHeadroomTokens: 27000,
    plannerStopLineTokens: 153000,
  });
});

test('getPlannerPromptBudget leaves 26,250 tokens of headroom for a 190k thinking context', () => {
  const config = getDefaultConfig();
  config.Runtime.LlamaCpp.NumCtx = 190000;
  getActiveModelPreset(config).Reasoning = 'on';

  const budget = getPlannerPromptBudget(config);
  assert.deepEqual(budget, {
    numCtxTokens: 190000,
    promptReserveTokens: 15000,
    usablePromptBudgetTokens: 175000,
    plannerHeadroomTokens: 26250,
    plannerStopLineTokens: 148750,
  });
});

test('planner activation threshold at exactly 75% stays on non-planner path', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      const plannerThreshold = Math.floor(
        getConfiguredLlamaNumCtx(config) * getEffectiveInputCharactersPerContextToken(config) * 0.75
      );

      const nonPlannerInput = 'A'.repeat(Math.max(plannerThreshold, 1));

      await summarizeRequest({
        question: 'summarize this',
        inputText: nonPlannerInput,
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });
      const nonPlannerRequest = server.state.chatRequests[server.state.chatRequests.length - 1];
      assert.doesNotMatch(JSON.stringify(nonPlannerRequest?.response_format || {}), /tool_name/u);
    }, {
      assistantContent(promptText, parsed) {
        if (JSON.stringify(asObject(parsed).response_format || {}).includes('tool_name')) {
          return JSON.stringify({
            action: 'finish',
            classification: 'summary',
            raw_review_required: false,
            output: 'planner finish',
          });
        }

        return '{"classification":"summary","raw_review_required":false,"output":"ok"}';
      },
    });
  });
});

