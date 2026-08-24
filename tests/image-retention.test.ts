import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ImageMetadataSchema } from '@siftkit/contracts';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import { ImageRetentionPolicy } from '../src/image-retention-policy.js';
import { countContentImages, extractContentText } from '../src/llm-protocol/image-attachments.js';
import type { ChatMessage as PlannerChatMessage } from '../src/repo-search/planner-protocol.js';
import { TranscriptManager } from '../src/repo-search/engine/transcript-manager.js';
import { buildReadPathKey } from '../src/repo-search/engine/read-overlap.js';
import { appendChatMessagesWithUsage, buildChatHistoryMessages } from '../src/status-server/chat.js';
import { readChatSessionFromPath, getChatSessionPath } from '../src/state/chat-sessions.js';
import { rasterBuffer } from './helpers/image-fixtures.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { createTestChatSession } from './helpers/chat-sessions.js';
import { makeProcessor } from './helpers/tool-action-processor.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const IMAGE_META = ImageMetadataSchema.parse({
  width: 1440,
  height: 900,
  originalWidth: 1440,
  originalHeight: 900,
  mime: 'image/png',
  byteLength: 412_000,
  tokenEstimate: 1024,
  resized: false,
  caption: null,
});

function imageMessage(url: string, label: string, imagePathKey?: string): PlannerChatMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: label }, { type: 'image_url', image_url: { url } }],
    ...(imagePathKey === undefined ? {} : { imagePathKey }),
  };
}

test('retention 8 keeps the 8 most recent images and degrades the ninth-oldest', () => {
  const messages = Array.from({ length: 9 }, (_, index) => imageMessage(
    `data:image/png;base64,I${index}`,
    `image docs/a${index}.png — 100×100`,
    buildReadPathKey(`docs/a${index}.png`),
  ));

  const dropped = new ImageRetentionPolicy(8).prune(messages);

  assert.deepEqual(dropped, ['docs/a0.png']);
  assert.deepEqual(messages[0].content, [
    { type: 'text', text: 'image docs/a0.png — 100×100' },
    { type: 'text', text: '[image docs/a0.png — 100×100, dropped from context]' },
  ]);
  assert.equal(countContentImages(messages[8].content), 1);
});

test('the window counts images, not messages', () => {
  const twoImages: PlannerChatMessage = {
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: 'data:image/png;base64,A' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,B' } },
    ],
  };
  const messages = [twoImages, imageMessage('data:image/png;base64,C', 'image docs/c.png — 10×10')];

  new ImageRetentionPolicy(2).prune(messages);

  assert.equal(countContentImages(messages[0].content), 1);
  assert.equal(countContentImages(messages[1].content), 1);
});

test('degrading one image leaves its live siblings untouched', () => {
  const message: PlannerChatMessage = {
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: 'data:image/png;base64,A' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,B' } },
    ],
  };

  new ImageRetentionPolicy(1).prune([message]);

  assert.equal(countContentImages(message.content), 1);
  assert.equal(extractContentText(message.content).includes('dropped from context'), true);
});

test('retention -1 never ages an image out', () => {
  const messages = Array.from({ length: 40 }, (_, index) => imageMessage(`data:image/png;base64,I${index}`, `image docs/a${index}.png — 10×10`));

  const dropped = new ImageRetentionPolicy(-1).prune(messages);

  assert.deepEqual(dropped, []);
  assert.equal(messages.reduce((total, message) => total + countContentImages(message.content), 0), 40);
});

test('retention 0 drops every image', () => {
  const messages = [imageMessage('data:image/png;base64,A', 'image docs/a.png — 10×10')];

  new ImageRetentionPolicy(0).prune(messages);

  assert.equal(countContentImages(messages[0].content), 0);
});

test('image retention returns structured identity without parsing display text', () => {
  const imagePath = 'docs/architecture diagrams/arch-final (v2), annotated.png';
  const imagePathKey = buildReadPathKey(imagePath);
  const liveImagePathKeys = new Set<string>([imagePathKey]);
  const message = imageMessage(PNG, 'display wording is not an identity protocol', imagePathKey);
  const dropped = new ImageRetentionPolicy(0).prune([message]);

  for (const droppedPathKey of dropped) {
    liveImagePathKeys.delete(droppedPathKey);
  }

  assert.deepEqual(dropped, [imagePathKey]);
  assert.equal(liveImagePathKeys.size, 0);
});

test('compaction that drops an image message releases its re-read guard', () => {
  const liveImagePathKeys = new Set<string>([buildReadPathKey('docs/arch.png')]);
  const transcript = new TranscriptManager({
    systemPromptContent: 'system',
    historyMessages: [],
    initialUserContent: 'hi',
    initialUserImages: [],
    liveImagePathKeys,
  });
  transcript.pushUser(
    'image docs/arch.png — 1440×900',
    ['data:image/png;base64,A'],
    buildReadPathKey('docs/arch.png'),
  );

  transcript.replaceWith([{ role: 'system', content: 'system' }, { role: 'user', content: 'compacted' }], 1);

  assert.equal(liveImagePathKeys.size, 0);
});

test('compaction that keeps an image message keeps its re-read guard', () => {
  const liveImagePathKeys = new Set<string>([buildReadPathKey('docs/arch.png')]);
  const transcript = new TranscriptManager({
    systemPromptContent: 'system',
    historyMessages: [],
    initialUserContent: 'hi',
    initialUserImages: [],
    liveImagePathKeys,
  });
  const pathKey = buildReadPathKey('docs/arch.png');
  const kept = imageMessage('data:image/png;base64,A', 'image docs/arch.png — 1440×900', pathKey);
  transcript.pushUser('image docs/arch.png — 1440×900', ['data:image/png;base64,A'], pathKey);

  transcript.replaceWith([{ role: 'system', content: 'system' }, kept], 1);

  assert.equal(liveImagePathKeys.has(buildReadPathKey('docs/arch.png')), true);
});

test('compaction retains structured image identity regardless of display wording', () => {
  const imagePath = 'docs/architecture diagrams/arch-final (v2), annotated.png';
  const imagePathKey = buildReadPathKey(imagePath);
  const liveImagePathKeys = new Set<string>([imagePathKey]);
  const transcript = new TranscriptManager({
    systemPromptContent: 'system',
    historyMessages: [],
    initialUserContent: 'hi',
    initialUserImages: [],
    liveImagePathKeys,
  });
  const kept = imageMessage(PNG, 'the label format may change freely', imagePathKey);

  transcript.replaceWith([{ role: 'system', content: 'system' }, kept], 1);
  assert.equal(liveImagePathKeys.has(imagePathKey), true);

  transcript.replaceWith([{ role: 'system', content: 'system' }, { role: 'user', content: 'compacted' }], 1);
  assert.equal(liveImagePathKeys.has(imagePathKey), false);
});

test('a tool image is persisted as a tool_image row right after its tool call', () => {
  const runtimeRoot = createManagedTempDir('image-persist');
  const session = createTestChatSession(runtimeRoot);

  const updated = appendChatMessagesWithUsage(runtimeRoot, session, 'question', 'answer', {}, {
    turns: [{
      thinkingText: '',
      toolMessages: [{
        id: 'tool-call-1',
        content: 'read path="docs/arch.png"',
        toolCallCommand: 'read path="docs/arch.png"',
        toolCallTurn: 1,
        toolCallMaxTurns: 1,
        toolCallExitCode: 0,
        toolCallOutputSnippet: 'Image docs/arch.png (1440×900) attached below.',
        toolCallOutput: 'Image docs/arch.png (1440×900) attached below.',
        outputTokens: null,
        images: [PNG],
        imageMeta: [IMAGE_META],
      }],
    }],
  });

  const kinds = (updated.messages ?? []).map((message) => message.kind);
  assert.deepEqual(kinds, ['user_text', 'assistant_tool_call', 'tool_image', 'assistant_answer']);
});

test('a persisted tool_image row survives a session reload with its data URL and metadata', () => {
  const runtimeRoot = createManagedTempDir('image-persist-reload');
  const session = createTestChatSession(runtimeRoot);
  appendChatMessagesWithUsage(runtimeRoot, session, 'question', 'answer', {}, {
    turns: [{
      thinkingText: '',
      toolMessages: [{
        id: 'tool-call-1',
        content: 'read path="docs/arch.png"',
        toolCallCommand: 'read path="docs/arch.png"',
        toolCallTurn: 1,
        toolCallMaxTurns: 1,
        toolCallExitCode: 0,
        toolCallOutputSnippet: 'Image docs/arch.png (1440×900) attached below.',
        toolCallOutput: 'Image docs/arch.png (1440×900) attached below.',
        outputTokens: null,
        images: [PNG],
        imageMeta: [IMAGE_META],
      }],
    }],
  });

  const reloaded = readChatSessionFromPath(getChatSessionPath(runtimeRoot, session.id));

  const imageMessage = (reloaded?.messages ?? []).find((message) => message.kind === 'tool_image');
  assert.ok(imageMessage);
  assert.deepEqual(imageMessage.images, [PNG]);
  assert.deepEqual(imageMessage.imageMeta, [IMAGE_META]);
});

test('a persisted tool_image replays immediately after its tool result', () => {
  const session = {
    ...createTestChatSession(createManagedTempDir('image-replay')),
    messages: [
      {
        id: 'u1',
        role: 'user' as const,
        kind: 'user_text' as const,
        content: 'look at the diagram',
        inputTokensEstimate: 0,
        outputTokensEstimate: 0,
        thinkingTokens: 0,
        createdAtUtc: '',
      },
      {
        id: 't1',
        role: 'assistant' as const,
        kind: 'assistant_tool_call' as const,
        content: 'read path="docs/arch.png"',
        toolCallCommand: 'read path="docs/arch.png"',
        toolCallOutput: 'Image docs/arch.png (1440×900) attached below.',
        inputTokensEstimate: 0,
        outputTokensEstimate: 0,
        thinkingTokens: 0,
        createdAtUtc: '',
      },
      {
        id: 'i1',
        role: 'user' as const,
        kind: 'tool_image' as const,
        content: '',
        images: [PNG],
        imageMeta: [IMAGE_META],
        inputTokensEstimate: 0,
        outputTokensEstimate: 0,
        thinkingTokens: 0,
        createdAtUtc: '',
      },
      {
        id: 'a1',
        role: 'assistant' as const,
        kind: 'assistant_answer' as const,
        content: 'it is a diagram',
        inputTokensEstimate: 0,
        outputTokensEstimate: 0,
        thinkingTokens: 0,
        createdAtUtc: '',
      },
    ],
  };

  const history = buildChatHistoryMessages(getDefaultConfigObject(), session);

  assert.deepEqual(history.map((message) => message.role), ['user', 'assistant', 'tool', 'user', 'assistant']);
  assert.deepEqual(history[3].content, [{ type: 'image_url', image_url: { url: PNG } }]);
});

test('chat replay applies the active preset image retention window', () => {
  const config = getDefaultConfigObject();
  const activePreset = config.Server.ModelPresets.Presets[0];
  activePreset.VisionImageRetention = 1;
  config.Server.ModelPresets.ActivePresetId = activePreset.id;
  const session = createTestChatSession(createManagedTempDir('image-replay-retention'));
  session.messages = Array.from({ length: 2 }, (_, index) => ({
    id: `image-${index}`,
    role: 'user' as const,
    kind: 'user_text' as const,
    content: `image docs/a${index}.png — 10×10`,
    inputTokensEstimate: 0,
    outputTokensEstimate: 0,
    thinkingTokens: 0,
    createdAtUtc: '',
    images: [PNG],
  }));

  const history = buildChatHistoryMessages(config, session);

  assert.deepEqual(history[0].content, [
    { type: 'text', text: 'image docs/a0.png — 10×10' },
    { type: 'text', text: '[image docs/a0.png — 10×10, dropped from context]' },
  ]);
  assert.equal(countContentImages(history[1].content), 1);
});

test('live transcript ages images out in place and releases the dropped path guard', async () => {
  const repoRoot = createManagedTempDir('image-live-retention');
  fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'docs/arch.png'), rasterBuffer('png', 1440, 900));
  fs.writeFileSync(path.join(repoRoot, 'docs/flow.png'), rasterBuffer('png', 800, 600));
  const { processor, commands, transcript } = makeProcessor(
    repoRoot,
    ['read'],
    'repo-search',
    null,
    undefined,
    { visionEnabled: true, visionImageRetention: 1 },
  );

  await processor.executeBatch(
    1,
    [
      { action: 'tool', tool_name: 'read', args: { path: 'docs/arch.png' } },
      { action: 'tool', tool_name: 'read', args: { path: 'docs/flow.png' } },
    ],
    '',
    { reported: 0, budgeted: 0 },
    false,
  );

  const imageMessages = transcript.getMessages().filter((message) => countContentImages(message.content) > 0 || extractContentText(message.content).includes('dropped from context'));
  assert.equal(imageMessages.length, 2);
  assert.equal(countContentImages(imageMessages[0]?.content), 0);
  assert.match(extractContentText(imageMessages[0]?.content), /^image docs\/arch\.png — 1440×900/u);
  assert.match(extractContentText(imageMessages[0]?.content), /dropped from context/u);
  assert.equal(countContentImages(imageMessages[1]?.content), 1);
  assert.equal(extractContentText(imageMessages[1]?.content), 'image docs/flow.png — 800×600');

  await processor.executeBatch(
    2,
    [{ action: 'tool', tool_name: 'read', args: { path: 'docs/arch.png' } }],
    '',
    { reported: 0, budgeted: 0 },
    false,
  );

  assert.equal(commands.at(-1)?.safe, true);
});
