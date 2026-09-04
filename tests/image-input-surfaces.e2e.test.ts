import { IsolatedRuntime } from './helpers/isolated-runtime.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModelRuntimePresetSchema } from '@siftkit/contracts';
import { parseChatMessageRequest } from '../src/status-server/chat-route-request-normalizers.js';
import { parseSummaryRequest } from '../src/status-server/route-request-normalizers.js';
import { buildUserContent, assertPresetAcceptsImages } from '../src/llm-protocol/image-attachments.js';
import { validateRepoSearchTokens } from '../src/cli/args.js';
import { parseRepoAgentInvocation } from '../src/cli/repo-agent-args.js';
import { buildRepoAgentServerRequest } from '../src/cli/repo-agent-request.js';
import { runTaskLoop } from '../src/repo-search/engine.js';
import { createEmptyPresetSystemContext } from './helpers/empty-preset-system-context.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { parseJsonValueText } from '../src/lib/json.js';
import { asObject } from './helpers/dashboard-http.js';
import { getDefaultConfigObject } from '../src/config/defaults.js';
import { mockSiftConfig } from './helpers/mock-config.js';
import { SummaryRequestRunner } from '../src/summary/request-runner.js';
import { executeRepoSearchRequest } from '../src/repo-search/execute.js';
import { INTERACTIVE_REPO_TOOL_NAMES } from '../src/planner-protocol/repo-search.js';
import { DeadEndpointEnv } from './helpers/dead-endpoints.js';
import { gifBufferWithSize, rasterBuffer, toDataUrl } from './helpers/image-fixtures.js';
import { readImageDimensions } from '../src/llm-protocol/image-admission.js';
import { sendChatCompletionSse } from './helpers/streaming-client.js';
import { RepoSearchRuntimeProfile } from '../src/repo-search/engine/runtime-profile.js';

const basePreset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
if (!basePreset) throw new Error('Default model preset is missing');
const visionOff = ModelRuntimePresetSchema.parse({ ...basePreset, Backend: 'exl3', VisionEnabled: false });
const zeroRetention = ModelRuntimePresetSchema.parse({
  ...basePreset,
  Backend: 'exl3',
  VisionEnabled: true,
  VisionImageRetention: 0,
});

const isolatedRuntime = new IsolatedRuntime();
const deadEndpoints = new DeadEndpointEnv();
before(() => { isolatedRuntime.start(); deadEndpoints.apply(); });
after(async () => { await isolatedRuntime.close(); deadEndpoints.restore(); });

async function withModelServer(
  responseContent: string,
  callback: (baseUrl: string, capturedBodies: string[]) => Promise<void>,
): Promise<void> {
  const capturedBodies: string[] = [];
  const server = http.createServer((req, res) => {
    if (req.url !== '/v1/chat/completions') {
      req.resume();
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      capturedBodies.push(body);
      sendChatCompletionSse(res, {
        choices: [{ message: { role: 'assistant', content: responseContent } }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = Number(address && typeof address === 'object' ? address.port : 0);
  try {
    await callback(`http://127.0.0.1:${port}`, capturedBodies);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function imageUrlDimensions(body: string): { width: number; height: number } {
  const imageUrl = body.match(/data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+/u)?.[0];
  assert.ok(imageUrl);
  const separator = imageUrl.indexOf(';base64,');
  const mime = imageUrl.slice('data:'.length, separator);
  const bytes = Buffer.from(imageUrl.slice(separator + ';base64,'.length), 'base64');
  return readImageDimensions(bytes, mime);
}

function imageRuntimePreset(baseUrl: string, visionMaxImagePixels: number): typeof basePreset {
  return ModelRuntimePresetSchema.parse({
    ...basePreset,
    id: 'repo-search',
    Backend: 'exl3',
    BaseUrl: baseUrl,
    Model: 'test-model',
    NumCtx: 30_000,
    VisionEnabled: true,
    VisionImageRetention: -1,
    VisionMaxImagePixels: visionMaxImagePixels,
  });
}

test('parseSummaryRequest accepts images and allows an images-only request', () => {
  const parsed = parseSummaryRequest({
    question: 'what is on screen?',
    inputText: '',
    repoRoot: 'C:\\repo',
    images: ['data:image/png;base64,AAAA'],
  });
  assert.notEqual(parsed, null);
  assert.deepEqual(parsed?.images, ['data:image/png;base64,AAAA']);
});

test('parseSummaryRequest still rejects an empty request with no images', () => {
  assert.equal(parseSummaryRequest({ question: 'q', inputText: '', repoRoot: 'C:\\repo' }), null);
});

test('parseSummaryRequest rejects a malformed image entry', () => {
  assert.throws(
    () => parseSummaryRequest({
      question: 'q',
      inputText: 'x',
      repoRoot: 'C:\\repo',
      images: ['https://example.com/a.png'],
    }),
    /supported-image/u,
  );
});

test('the summary planner puts an image part on the initial user turn', () => {
  const content = buildUserContent('question and input', ['data:image/png;base64,AAAA']);
  assert.deepEqual(content, [
    { type: 'text', text: 'question and input' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
  ]);
});

test('repo-search accepts a repeatable --image flag', () => {
  validateRepoSearchTokens(['--prompt', 'find it', '--image', 'a.png', '--image', 'b.png']);
  assert.throws(
    () => validateRepoSearchTokens(['--prompt', 'find it', '--image']),
    /Missing value for repo-search option: --image/u,
  );
});

test('repo-search puts the image part on the first user message it sends', async () => {
  const capturedBodies: string[] = [];
  const server = http.createServer((req, res) => {
    // Only chat completions are recorded; tokenize preflight 404s and falls back to the estimate.
    if (req.url !== '/v1/chat/completions') {
      req.resume();
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      capturedBodies.push(body);
      sendChatCompletionSse(res, {
        choices: [{ message: { role: 'assistant', content: '{"action":"finish","output":"done"}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = Number(address && typeof address === 'object' ? address.port : 0);
  try {
    await runTaskLoop(
      { id: 'img', question: 'what is this?' },
      {
        repoRoot: os.tmpdir(),
        systemContext: createEmptyPresetSystemContext(),
        model: 'mock',
        baseUrl: `http://127.0.0.1:${port}`,
        runtimeProfile: new RepoSearchRuntimeProfile('chat'),
        config: mockSiftConfig({ Server: { ModelPresets: { Presets: [{ BaseUrl: `http://127.0.0.1:${port}` }] } } }),
        maxTurns: 1,
        maxInvalidResponses: 1,
        minToolCallsBeforeFinish: 0,
        plannerToolDefinitions: [],
        initialUserImages: ['data:image/png;base64,AAAA'],
        mockCommandResults: {},
      },
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  const first = asObject(parseJsonValueText(capturedBodies[0] ?? '{}'));
  assert.equal(JSON.stringify(first).includes('"image_url"'), true);
  assert.equal(JSON.stringify(first).includes('data:image/png;base64,AAAA'), true);
});

test('executeRepoSearchRequest admits an oversized data URL before repo-search model content', async () => {
  const oversizedUrl = `data:image/png;base64,${rasterBuffer('png', 2000, 1000).toString('base64')}`;
  await withModelServer(
    'done',
    async (baseUrl, capturedBodies) => {
      const preset = imageRuntimePreset(baseUrl, 500_000);
      const dir = createManagedTempDir('siftkit-admit-repo-search-');
      try {
        await executeRepoSearchRequest({
          presetId: preset.id,
          taskKind: 'repo-search',
          prompt: 'describe the image',
          repoRoot: dir,
          config: mockSiftConfig({
            Server: {
              ModelPresets: { Presets: [preset], ActivePresetId: preset.id },
            },
          }),
          model: 'test-model',
          allowedTools: [...INTERACTIVE_REPO_TOOL_NAMES],
          availableModels: ['test-model'],
          initialUserImages: [oversizedUrl],
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }

      const imageBody = capturedBodies.find((body) => body.includes('"image_url"'));
      assert.ok(imageBody);
      assert.equal(imageBody.includes(oversizedUrl), false);
      const dimensions = imageUrlDimensions(imageBody);
      assert.ok(dimensions.width * dimensions.height <= 500_000);
    },
  );
});


test('repo-agent collects repeatable --image values', () => {
  const invocation = parseRepoAgentInvocation(['fix the layout', '--image', 'a.png', '--image', 'b.png']);
  assert.equal(invocation.kind, 'start');
  assert.deepEqual(invocation.kind === 'start' ? invocation.images : [], ['a.png', 'b.png']);
});

test('repo-agent defaults images to an empty array', () => {
  const invocation = parseRepoAgentInvocation(['fix the layout']);
  assert.deepEqual(invocation.kind === 'start' ? invocation.images : null, []);
});

// The CLI resolves local paths to data URIs before sending them to the server-owned run.
test('repo-agent encodes its image paths as data URIs on the request body', () => {
  const root = createManagedTempDir('siftkit-agent-img-');
  const imagePath = join(root, 'shot.png');
  const bytes = rasterBuffer('png', 1, 1);
  writeFileSync(imagePath, bytes);
  try {
    const request = buildRepoAgentServerRequest({
      task: 'describe the screenshot',
      repoRoot: root,
      approval: 'auto',
      images: [imagePath],
    });
    assert.deepEqual(request.images, [`data:image/png;base64,${bytes.toString('base64')}`]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repo-agent omits images from the request body when none were given', () => {
  const request = buildRepoAgentServerRequest({
    task: 'no images here',
    repoRoot: process.cwd(),
    approval: 'auto',
    images: [],
  });
  assert.equal('images' in request, false);
});

test('chat message requests carry validated images', () => {
  const parsed = parseChatMessageRequest({
    content: 'what is this?',
    images: ['data:image/webp;base64,AAAA'],
  });
  assert.deepEqual(parsed?.images, ['data:image/webp;base64,AAAA']);
});

test('chat message requests accept an image with empty text', () => {
  const parsed = parseChatMessageRequest({ content: '', images: ['data:image/png;base64,AAAA'] });
  assert.notEqual(parsed, null);
});

test('chat message requests reject a non-image URL', () => {
  assert.throws(
    () => parseChatMessageRequest({ content: 'x', images: ['file:///c:/a.png'] }),
    /supported-image/u,
  );
});

// ── Preset guard: direct and per-surface ────────────────────────────────

test('assertPresetAcceptsImages rejects when VisionEnabled is false', () => {
  assert.throws(
    () => assertPresetAcceptsImages(visionOff, ['data:image/png;base64,AAAA']),
    /Vision is not enabled/u,
  );
});

test('the summary runner refuses an image when the preset has no vision', async () => {
  await assert.rejects(
    () => new SummaryRequestRunner({
      repoRoot: 'C:\\repo',
      question: 'what is this?',
      inputText: 'sample input',
      images: ['data:image/png;base64,AAAA'],
      format: 'text',
      policyProfile: 'general',
      config: mockSiftConfig({
        Server: {
          ModelPresets: {
            Presets: [visionOff],
            ActivePresetId: visionOff.id,
          },
        },
      }),
    }).run(),
    /Vision is not enabled/u,
  );
});

test('the summary runner refuses an image when retention is zero', async () => {
  const config = mockSiftConfig({
    Server: {
      ModelPresets: {
        Presets: [zeroRetention],
        ActivePresetId: zeroRetention.id,
      },
    },
  });
  await assert.rejects(
    () => new SummaryRequestRunner({
      repoRoot: 'C:\\repo',
      question: 'what is this?',
      inputText: 'sample input',
      images: ['data:image/png;base64,AAAA'],
      format: 'text',
      policyProfile: 'general',
      config,
    }).run(),
    /Image input is disabled for this preset \(VisionImageRetention = 0\)/u,
  );
});

test('the summary runner keeps malformed and oversized GIF admission errors explicit', async () => {
  const visionOn = ModelRuntimePresetSchema.parse({
    ...basePreset,
    Backend: 'exl3',
    VisionEnabled: true,
    VisionImageRetention: -1,
    VisionMaxImagePixels: 1_000_000,
  });
  const config = mockSiftConfig({
    Server: {
      ModelPresets: {
        Presets: [visionOn],
        ActivePresetId: visionOn.id,
      },
    },
  });
  await assert.rejects(
    () => new SummaryRequestRunner({
      repoRoot: 'C:\\repo',
      question: 'what is this?',
      inputText: 'sample input',
      images: ['https://example.com/image.png'],
      format: 'text',
      policyProfile: 'general',
      config,
    }).run(),
    /supported-image/u,
  );
  await assert.rejects(
    () => new SummaryRequestRunner({
      repoRoot: 'C:\\repo',
      question: 'what is this?',
      inputText: 'sample input',
      images: [toDataUrl('image/gif', gifBufferWithSize(8000, 8000))],
      format: 'text',
      policyProfile: 'general',
      config,
    }).run(),
    /this preset accepts up to 1\.0 MP/u,
  );
});

test('the repo-search runner refuses an image when the preset has no vision', async () => {
  const dir = createManagedTempDir('siftkit-guard-');
  try {
    await assert.rejects(
      () => executeRepoSearchRequest({
        presetId: 'repo-search',
        taskKind: 'repo-search',
        prompt: 'find it',
        repoRoot: dir,
        config: mockSiftConfig({
          Server: {
            ModelPresets: {
              Presets: [visionOff],
              ActivePresetId: visionOff.id,
            },
          },
        }),
        model: 'mock',
        allowedTools: [...INTERACTIVE_REPO_TOOL_NAMES],
        availableModels: ['mock'],
        mockResponses: [{ content: "done" }],
        mockCommandResults: {},
        initialUserImages: ['data:image/png;base64,AAAA'],
      }),
      /Vision is not enabled/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the repo-search runner refuses an image when retention is zero', async () => {
  const dir = createManagedTempDir('siftkit-guard-retention-');
  try {
    await assert.rejects(
      () => executeRepoSearchRequest({
        presetId: 'repo-search',
        taskKind: 'repo-search',
        prompt: 'find it',
        repoRoot: dir,
        config: mockSiftConfig({
          Server: {
            ModelPresets: {
              Presets: [zeroRetention],
              ActivePresetId: zeroRetention.id,
            },
          },
        }),
        model: 'mock',
        allowedTools: [...INTERACTIVE_REPO_TOOL_NAMES],
        availableModels: ['mock'],
        mockResponses: [{ content: "done" }],
        mockCommandResults: {},
        initialUserImages: ['data:image/png;base64,AAAA'],
      }),
      /Image input is disabled for this preset \(VisionImageRetention = 0\)/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// repo-agent reaches the model through the same executeRepoSearchRequest entry as
// repo-search, so this pins the agent taskKind against the same guard.
test('the repo-agent runner refuses an image when the preset has no vision', async () => {
  const dir = createManagedTempDir('siftkit-guard-agent-');
  try {
    await assert.rejects(
      () => executeRepoSearchRequest({
        presetId: 'repo-agent',
        taskKind: 'repo-agent',
        prompt: 'fix the layout',
        repoRoot: dir,
        config: mockSiftConfig({
          Server: {
            ModelPresets: {
              Presets: [visionOff],
              ActivePresetId: visionOff.id,
            },
          },
        }),
        model: 'mock',
        allowedTools: [...INTERACTIVE_REPO_TOOL_NAMES],
        availableModels: ['mock'],
        mockResponses: [{ content: "done" }],
        mockCommandResults: {},
        initialUserImages: ['data:image/png;base64,AAAA'],
      }),
      /Vision is not enabled/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
