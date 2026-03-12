const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  loadConfig,
  saveConfig,
  getChunkThresholdCharacters,
} = require('../dist/src/config.js');
const { summarizeRequest } = require('../dist/src/summary.js');
const { runCommand } = require('../dist/src/command.js');
const { getOllamaLoadedModels } = require('../dist/src/providers/ollama.js');

function withTempEnv(fn) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-node-test-'));
  const previous = {
    USERPROFILE: process.env.USERPROFILE,
    sift_kit_status: process.env.sift_kit_status,
    SIFTKIT_TEST_PROVIDER: process.env.SIFTKIT_TEST_PROVIDER,
    SIFTKIT_TEST_PROVIDER_BEHAVIOR: process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR,
    SIFTKIT_TEST_PROVIDER_LOG_PATH: process.env.SIFTKIT_TEST_PROVIDER_LOG_PATH,
    SIFTKIT_TEST_PROVIDER_SLEEP_MS: process.env.SIFTKIT_TEST_PROVIDER_SLEEP_MS,
    SIFTKIT_CONFIG_SERVICE_URL: process.env.SIFTKIT_CONFIG_SERVICE_URL,
    SIFTKIT_TEST_OLLAMA_PS_OUTPUT: process.env.SIFTKIT_TEST_OLLAMA_PS_OUTPUT,
  };

  process.env.USERPROFILE = tempRoot;
  delete process.env.sift_kit_status;
  delete process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR;
  delete process.env.SIFTKIT_TEST_PROVIDER_LOG_PATH;
  delete process.env.SIFTKIT_TEST_PROVIDER_SLEEP_MS;
  delete process.env.SIFTKIT_CONFIG_SERVICE_URL;
  delete process.env.SIFTKIT_TEST_OLLAMA_PS_OUTPUT;
  process.env.SIFTKIT_TEST_PROVIDER = 'mock';

  const cleanup = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  };

  return Promise.resolve()
    .then(() => fn(tempRoot))
    .finally(cleanup);
}

test('loadConfig normalizes legacy defaults and derives effective budgets', async () => {
  await withTempEnv(async (tempRoot) => {
    const runtimeRoot = path.join(tempRoot, '.siftkit');
    fs.mkdirSync(runtimeRoot, { recursive: true });
    fs.writeFileSync(
      path.join(runtimeRoot, 'config.json'),
      JSON.stringify({
        Version: '0.1.0',
        Backend: 'ollama',
        Model: 'qwen3.5:9b-q4_K_M',
        PolicyMode: 'conservative',
        RawLogRetention: true,
        Ollama: {
          BaseUrl: 'http://127.0.0.1:11434',
          ExecutablePath: 'mock.exe',
          NumCtx: 16384,
        },
        Thresholds: {
          MinCharactersForSummary: 500,
          MinLinesForSummary: 16,
          MaxInputCharacters: 32000,
          ChunkThresholdRatio: 0.75,
        },
        Interactive: {
          Enabled: true,
          WrappedCommands: ['git'],
          IdleTimeoutMs: 900000,
          MaxTranscriptCharacters: 60000,
          TranscriptRetention: true,
        },
      }),
      'utf8'
    );

    const config = await loadConfig({ ensure: true });
    assert.equal(config.Ollama.NumCtx, 128000);
    assert.equal(config.Effective.MaxInputCharacters, 320000);
    assert.equal(config.Effective.ChunkThresholdCharacters, 294400);
    assert.equal(config.Thresholds.MaxInputCharacters, undefined);
  });
});

test('summarizeRequest recursively merges oversized mock summaries', async () => {
  await withTempEnv(async (tempRoot) => {
    process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR = 'recursive-merge';
    const logPath = path.join(tempRoot, 'provider-events.jsonl');
    process.env.SIFTKIT_TEST_PROVIDER_LOG_PATH = logPath;

    const config = await loadConfig({ ensure: true });
    const threshold = getChunkThresholdCharacters(config);
    const result = await summarizeRequest({
      question: 'summarize this',
      inputText: 'A'.repeat((threshold * 3) + 1),
      format: 'text',
      policyProfile: 'general',
      backend: 'mock',
      model: 'mock-model',
    });

    const events = fs.readFileSync(logPath, 'utf8')
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line));
    const leafCalls = events.filter((event) => event.phase === 'leaf').length;
    const mergeCalls = events.filter((event) => event.phase === 'merge').length;

    assert.equal(result.WasSummarized, true);
    assert.equal(result.Summary, 'merge summary');
    assert.equal(leafCalls, 4);
    assert.ok(mergeCalls > 1);
  });
});

test('runCommand saves a raw log and respects no-summarize mode', async () => {
  await withTempEnv(async () => {
    const result = await runCommand({
      Command: 'node',
      ArgumentList: ['-e', "console.log('stdout line'); console.error('stderr line');"],
      Question: 'what failed?',
      Backend: 'mock',
      Model: 'mock-model',
      NoSummarize: true,
    });

    assert.equal(result.WasSummarized, false);
    assert.ok(result.RawLogPath);
    assert.equal(fs.existsSync(result.RawLogPath), true);
    const rawLog = fs.readFileSync(result.RawLogPath, 'utf8');
    assert.match(rawLog, /stdout line/u);
    assert.match(rawLog, /stderr line/u);
  });
});

test('saveConfig throws clearly when the config service is unreachable', async () => {
  await withTempEnv(async () => {
    process.env.SIFTKIT_CONFIG_SERVICE_URL = 'http://127.0.0.1:4779/config';
    const config = await loadConfig({ ensure: true });
    await assert.rejects(() => saveConfig(config), /config|ECONNREFUSED|connect/u);
  });
});

test('getOllamaLoadedModels parses Windows-style table output', async () => {
  await withTempEnv(async () => {
    process.env.SIFTKIT_TEST_OLLAMA_PS_OUTPUT = [
      'NAME                ID              SIZE      PROCESSOR    CONTEXT    UNTIL',
      'qwen3.5:9b-q4_K_M   abc123          5.5 GB    100% GPU     128000     4 minutes from now',
      'qwen3.5:2b          def456          1.7 GB    100% GPU     32768      2 minutes from now',
    ].join('\n');

    const loadedModels = getOllamaLoadedModels('ignored.exe');
    assert.equal(loadedModels.length, 2);
    assert.equal(loadedModels[0].Name, 'qwen3.5:9b-q4_K_M');
    assert.equal(loadedModels[0].Context, 128000);
    assert.equal(loadedModels[1].Name, 'qwen3.5:2b');
    assert.equal(loadedModels[1].Context, 32768);
  });
});
