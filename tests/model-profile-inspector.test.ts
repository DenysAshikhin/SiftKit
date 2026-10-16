import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

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
