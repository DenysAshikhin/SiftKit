import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { executeRepoTool } from '../src/repo-search/engine/repo-tools.js';
import type { JsonObject } from '../src/lib/json-types.js';
import {
  RepoNativeToolCallSchema,
  type RepoNativeToolCall,
} from '../src/repo-search/repo-tool-arguments.js';
import { TranscriptManager } from '../src/repo-search/engine/transcript-manager.js';
import { getSupportedImageExtensions } from '../src/llm-protocol/image-attachments.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { gifBufferWithSize, rasterBuffer } from './helpers/image-fixtures.js';
import { makeRepoToolContext } from './helpers/repo-tool-context.js';
import { makeProcessor } from './helpers/tool-action-processor.js';

function nativeCall(toolName: string, args: JsonObject): RepoNativeToolCall {
  return RepoNativeToolCallSchema.parse({ toolName, args });
}

function writeFixtureImages(repoRoot: string): void {
  fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'docs/arch.png'), rasterBuffer('png', 120, 80));
  fs.writeFileSync(path.join(repoRoot, 'docs/arch.jpg'), rasterBuffer('jpeg', 120, 80));
  fs.writeFileSync(path.join(repoRoot, 'docs/arch.jpeg'), rasterBuffer('jpeg', 120, 80));
  fs.writeFileSync(path.join(repoRoot, 'docs/arch.webp'), rasterBuffer('webp', 120, 80));
  fs.writeFileSync(path.join(repoRoot, 'docs/arch.gif'), gifBufferWithSize(120, 80));
}

async function runImageReadTurnRoles(repoRoot: string, paths: string[]): Promise<string[]> {
  const { processor, transcript } = makeProcessor(
    repoRoot,
    ['read'],
    'repo-search',
    null,
    undefined,
    { visionEnabled: true },
  );
  await processor.executeBatch(
    1,
    paths.map((imagePath) => ({ action: 'tool' as const, tool_name: 'read', args: { path: imagePath } })),
    '',
    { reported: 0, budgeted: 0 },
    false,
  );
  return transcript.messageRoles();
}

test('read returns an image for every supported extension when vision is on', async () => {
  const repoRoot = createManagedTempDir('image-read-formats');
  writeFixtureImages(repoRoot);
  const context = makeRepoToolContext({ repoRoot, visionEnabled: true });

  for (const extension of getSupportedImageExtensions()) {
    const result = await executeRepoTool(nativeCall('read', { path: `docs/arch${extension}` }), context);
    assert.equal(result.ok, true, extension);
    assert.ok(result.ok && result.imageDataUrl, `${extension} carries an imageDataUrl`);
    assert.match(result.ok ? result.output : '', /^Image docs\/arch\..+ \(120×80\) attached below\.$/u);
  }
});

test('read refuses an image when the preset has no vision', async () => {
  const repoRoot = createManagedTempDir('image-read-no-vision');
  writeFixtureImages(repoRoot);
  const context = makeRepoToolContext({ repoRoot, visionEnabled: false });

  const result = await executeRepoTool(nativeCall('read', { path: 'docs/arch.png' }), context);

  assert.equal(result.ok, false);
  assert.equal(
    result.ok ? '' : result.reason,
    'reading images requires an exl3 preset with VisionEnabled; this preset is text-only',
  );
});

test('read refuses an image when retention is zero, with the retention message', async () => {
  const repoRoot = createManagedTempDir('image-read-retention-zero');
  writeFixtureImages(repoRoot);
  const context = makeRepoToolContext({ repoRoot, visionEnabled: true, visionImageRetention: 0 });

  const result = await executeRepoTool(nativeCall('read', { path: 'docs/arch.png' }), context);

  assert.equal(result.ok, false);
  assert.equal(
    result.ok ? '' : result.reason,
    'Image input is disabled for this preset (VisionImageRetention = 0)',
  );
});

test('read rejects offset on an image path rather than ignoring it', async () => {
  const repoRoot = createManagedTempDir('image-read-offset');
  writeFixtureImages(repoRoot);
  const context = makeRepoToolContext({ repoRoot, visionEnabled: true });

  const result = await executeRepoTool(nativeCall('read', { path: 'docs/arch.png', offset: 2 }), context);

  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.reason, /offset and limit do not apply to images/u);
});

test('read rejects limit on an image path', async () => {
  const repoRoot = createManagedTempDir('image-read-limit');
  writeFixtureImages(repoRoot);
  const context = makeRepoToolContext({ repoRoot, visionEnabled: true });

  const result = await executeRepoTool(nativeCall('read', { path: 'docs/arch.png', limit: 5 }), context);

  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.reason, /offset and limit do not apply to images/u);
});

test('read on an image keeps the ignore-policy and existence checks', async () => {
  const repoRoot = createManagedTempDir('image-read-missing');
  const context = makeRepoToolContext({ repoRoot, visionEnabled: true });

  const result = await executeRepoTool(nativeCall('read', { path: 'docs/nope.png' }), context);

  assert.equal(result.ok, false);
  assert.equal(result.ok ? '' : result.reason, 'path is not a readable file');
});

test('read on an image produces no lineReadStats', async () => {
  const repoRoot = createManagedTempDir('image-read-stats');
  writeFixtureImages(repoRoot);
  const context = makeRepoToolContext({ repoRoot, visionEnabled: true });

  const result = await executeRepoTool(nativeCall('read', { path: 'docs/arch.png' }), context);

  assert.equal(result.ok && result.lineReadStats, undefined);
  assert.equal(result.ok && result.readFile, undefined);
});

test('TranscriptManager.pushUser attaches images as image_url parts', () => {
  const transcript = new TranscriptManager({
    systemPromptContent: 'system',
    historyMessages: [],
    initialUserContent: 'hello',
    initialUserImages: [],
    liveImagePathKeys: new Set<string>(),
  });

  transcript.pushUser('look', ['data:image/png;base64,AAAA']);

  const last = transcript.getMessages().at(-1);
  assert.equal(last?.role, 'user');
  assert.deepEqual(last?.content, [
    { type: 'text', text: 'look' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
  ]);
});

test('an image read appends exactly one user message immediately after its tool result', async () => {
  const repoRoot = createManagedTempDir('image-read-transcript');
  writeFixtureImages(repoRoot);

  const roles = await runImageReadTurnRoles(repoRoot, ['docs/arch.png']);

  assert.deepEqual(roles.slice(-3), ['assistant', 'tool', 'user']);
});

test('two image reads in one batch each land after their own tool result', async () => {
  const repoRoot = createManagedTempDir('image-read-transcript-batch');
  writeFixtureImages(repoRoot);

  const roles = await runImageReadTurnRoles(repoRoot, ['docs/arch.png', 'docs/arch.webp']);

  assert.deepEqual(roles.slice(-5), ['assistant', 'tool', 'user', 'tool', 'user']);
});

test('a second read of a live image is refused', async () => {
  const repoRoot = createManagedTempDir('image-read-dedup');
  writeFixtureImages(repoRoot);
  const context = makeRepoToolContext({ repoRoot, visionEnabled: true });

  const first = await executeRepoTool(nativeCall('read', { path: 'docs/arch.png' }), context);
  assert.equal(first.ok, true);
  context.liveImagePathKeys.add(first.ok ? first.imagePathKey ?? '' : '');

  const second = await executeRepoTool(nativeCall('read', { path: 'docs/arch.png' }), context);

  assert.equal(second.ok, false);
  assert.match(second.ok ? '' : second.reason, /already attached in this context/u);
});

test('re-reading is permitted again once the image is no longer live', async () => {
  const repoRoot = createManagedTempDir('image-read-dedup-release');
  writeFixtureImages(repoRoot);
  const context = makeRepoToolContext({ repoRoot, visionEnabled: true });

  const first = await executeRepoTool(nativeCall('read', { path: 'docs/arch.png' }), context);
  const pathKey = first.ok ? first.imagePathKey ?? '' : '';
  context.liveImagePathKeys.add(pathKey);
  context.liveImagePathKeys.delete(pathKey);

  const second = await executeRepoTool(nativeCall('read', { path: 'docs/arch.png' }), context);

  assert.equal(second.ok, true);
});
