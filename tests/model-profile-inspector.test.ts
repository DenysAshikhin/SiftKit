import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createManagedTempDir } from './helpers/temp-dirs.ts';
import type { ModelProfile } from '@siftkit/contracts';

import { inspectModelDirectory, readTemplateThinking } from '../src/inference-presets/model-profile-inspector.ts';

// Excerpts of the shipped chat templates, keeping every line that reads the inspected kwargs.
const GLM_TEMPLATE = [
  "[gMASK]<sop>",
  "{%- set effective_reasoning_effort = reasoning_effort if reasoning_effort is defined and reasoning_effort in ['low', 'high'] else 'max' -%}",
  "{%- if effective_reasoning_effort is not none -%}<|system|>Reasoning Effort: {{ effective_reasoning_effort | capitalize }}{%- endif -%}",
  "{%- set clear_thinking = clear_thinking if clear_thinking is defined else false -%}",
].join('\n');
const QWEN_TEMPLATE = [
  "{%- if enable_thinking is undefined or enable_thinking is true %}",
  "    {%- set resolved_reasoning_effort = reasoning_effort|default('xhigh') %}",
  "    {%- if resolved_reasoning_effort not in ('xhigh', 'medium', 'low') %}",
  "        {{- raise_exception('Unexpected reasoning effort ' ~ reasoning_effort ~ '. Supported types are xhigh (default), medium, and low.') }}",
  "    {%- if resolved_reasoning_effort == 'xhigh' %}",
  "        {%- if preserve_thinking is undefined or preserve_thinking is true or loop.index0 > ns.last_query_index %}",
].join('\n');

function withModelDirectory(files: Record<string, string>, run: (directory: string) => void): void {
  const directory = createManagedTempDir('siftkit-model-');
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(directory, name), content);
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('a GLM-5.3-Flash directory profiles as MoE, recurrent, MTP, vision, MLA, without n-gram or a thinking toggle', () => {
  withModelDirectory({
    'config.json': JSON.stringify({
      architectures: ['Glm5NextForConditionalGeneration'],
      text_config: {
        n_routed_experts: 288, layer_types: ['linear_attention', 'deepseek_sparse_attention'],
        num_nextn_predict_layers: 1, kv_lora_rank: 512,
      },
      vision_config: { depth: 24 },
    }),
    'generation_config.json': JSON.stringify({ temperature: 1.0, top_p: 0.95 }),
    'chat_template.jinja': GLM_TEMPLATE,
  }, (directory) => {
    const profile = inspectModelDirectory(directory);

    assert.equal(profile.architecture, 'Glm5NextForConditionalGeneration');
    assert.deepEqual(
      [profile.moe, profile.recurrent, profile.mtp, profile.vision, profile.ngram, profile.mla],
      [true, true, true, true, false, true],
    );
    assert.deepEqual(profile.reasoningEfforts, ['low', 'high', 'max']);
    assert.equal(profile.thinkingToggle, false);
    assert.equal(profile.preserveThinking, false);
    assert.deepEqual(profile.sampling, { temperature: 1.0, topP: 0.95, topK: null });
  });
});

test('a dense Qwen3.8 directory profiles its template levels, thinking toggle, and n-gram table', () => {
  withModelDirectory({
    'config.json': JSON.stringify({
      architectures: ['Qwen3_5ForConditionalGeneration'],
      text_config: { layer_types: ['linear_attention', 'full_attention'], mtp_num_hidden_layers: 1, ngram_size: 3 },
    }),
    'generation_config.json': JSON.stringify({ temperature: 1.0, top_p: 0.95, top_k: 20 }),
    'chat_template.jinja': QWEN_TEMPLATE,
  }, (directory) => {
    const profile = inspectModelDirectory(directory);

    assert.deepEqual(
      [profile.moe, profile.recurrent, profile.mtp, profile.vision, profile.ngram, profile.mla],
      [false, true, true, false, true, false],
    );
    assert.deepEqual(profile.reasoningEfforts, ['low', 'medium', 'xhigh']);
    assert.equal(profile.thinkingToggle, true);
    assert.equal(profile.preserveThinking, true);
    assert.deepEqual(profile.sampling, { temperature: 1.0, topP: 0.95, topK: 20 });
  });
});

test('a template embedded in tokenizer_config.json is inspected when no chat_template.jinja exists', () => {
  withModelDirectory({
    'config.json': JSON.stringify({ architectures: ['LlamaForCausalLM'], num_local_experts: 0 }),
    'tokenizer_config.json': JSON.stringify({ chat_template: GLM_TEMPLATE }),
  }, (directory) => {
    const profile = inspectModelDirectory(directory);

    assert.equal(profile.moe, false);
    assert.deepEqual(profile.reasoningEfforts, ['low', 'high', 'max']);
    assert.deepEqual(profile.sampling, { temperature: null, topP: null, topK: null });
  });
});

test('a template that never reads the thinking kwargs distinguishes no levels and cannot toggle thinking', () => {
  withModelDirectory({ 'chat_template.jinja': "{{ '<|user|>' + message.content }}" }, (directory) => {
    assert.deepEqual(readTemplateThinking(directory), { reasoningEfforts: [], thinkingToggle: false, preserveThinking: false });
  });
});

test('a directory without any chat template constrains no thinking setting', () => {
  withModelDirectory({ 'config.json': JSON.stringify({ architectures: ['LlamaForCausalLM'] }) }, (directory) => {
    const profile = inspectModelDirectory(directory);

    assert.deepEqual(readTemplateThinking(directory), { reasoningEfforts: [], thinkingToggle: true, preserveThinking: true });
    assert.equal(profile.thinkingToggle, true);
    assert.equal(profile.preserveThinking, true);
  });
});

test('a directory without config.json or with malformed config fails loudly', () => {
  withModelDirectory({}, (directory) => {
    assert.throws(() => inspectModelDirectory(directory), /config\.json/u);
  });
  withModelDirectory({ 'config.json': '{ not json' }, (directory) => {
    assert.throws(() => inspectModelDirectory(directory));
  });
  withModelDirectory({ 'config.json': JSON.stringify({ architectures: [] }) }, (directory) => {
    assert.throws(() => inspectModelDirectory(directory));
  });
});

const HYBRID_TEXT_CONFIG = {
  num_hidden_layers: 4, num_attention_heads: 16, num_key_value_heads: 2, head_dim: 256, hidden_size: 2048,
  layer_types: ['linear_attention', 'linear_attention', 'linear_attention', 'full_attention'],
  linear_num_key_heads: 16, linear_num_value_heads: 48, linear_key_head_dim: 128, linear_value_head_dim: 128,
  linear_conv_kernel_dim: 4, mtp_num_hidden_layers: 1,
};

function geometryOf(config: object): ModelProfile['cacheGeometry'] | undefined {
  let geometry: ModelProfile['cacheGeometry'] | undefined;
  withModelDirectory({ 'config.json': JSON.stringify(config) }, (directory) => {
    geometry = inspectModelDirectory(directory).cacheGeometry;
  });
  return geometry;
}

test('a hybrid model declares its KV and recurrent snapshot geometry', () => {
  // 3 linear layers × (10240 × 4 × 2 + 48 × 128 × 128 × 2) bytes of fp16 state
  assert.deepEqual(geometryOf({ architectures: ['Qwen3NextForCausalLM'], text_config: HYBRID_TEXT_CONFIG }),
    { attentionLayers: 1, kvTokenDim: 512, mtpLayers: 1, recurrentSnapshotBytes: 4_964_352 });
});

test('a dense model derives head_dim and has no recurrent snapshots', () => {
  assert.deepEqual(geometryOf({ architectures: ['LlamaForCausalLM'], num_hidden_layers: 32, num_attention_heads: 32, num_key_value_heads: 8, hidden_size: 4096 }),
    { attentionLayers: 32, kvTokenDim: 1024, mtpLayers: 0, recurrentSnapshotBytes: 0 });
});

test('a dense model with sliding-window layers counts every layer as full attention, an upper bound', () => {
  assert.deepEqual(geometryOf({ architectures: ['Gemma3ForCausalLM'], num_attention_heads: 8, num_key_value_heads: 4, head_dim: 256,
    layer_types: ['sliding_attention', 'sliding_attention', 'full_attention'] }),
  { attentionLayers: 3, kvTokenDim: 1024, mtpLayers: 0, recurrentSnapshotBytes: 0 });
});

test('a null config key reads as absent instead of breaking the whole profile', () => {
  assert.deepEqual(geometryOf({ architectures: ['MistralForCausalLM'], num_hidden_layers: 2, num_attention_heads: 8, num_key_value_heads: 2, hidden_size: 1024, head_dim: null }),
    { attentionLayers: 2, kvTokenDim: 256, mtpLayers: 0, recurrentSnapshotBytes: 0 });
});

test('cache geometry names why it cannot be derived', () => {
  assert.equal(geometryOf({ architectures: ['Fake'] }), 'config.json has no num_hidden_layers');
  assert.equal(geometryOf({ architectures: ['DeepseekV3ForCausalLM'], num_hidden_layers: 2, kv_lora_rank: 512 }),
    'MLA attention (kv_lora_rank) is not modelled');
  assert.equal(geometryOf({ architectures: ['X'], layer_types: ['mamba'], num_key_value_heads: 1, head_dim: 64 }),
    "layer type 'mamba' is not modelled");
  const { linear_conv_kernel_dim: _dropped, ...noKernel } = HYBRID_TEXT_CONFIG;
  assert.equal(geometryOf({ architectures: ['Qwen3NextForCausalLM'], text_config: noKernel }),
    'config.json has no linear_conv_kernel_dim');
});
