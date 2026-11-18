import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { ReasoningEffortSchema, type CacheGeometry, type ModelProfile, type ReasoningEffort } from '@siftkit/contracts';
import { parseJsonValueText } from '../lib/json.ts';

// Hugging Face configs write null for an unset dimension, which must read as absent, not fail the profile.
const OptionalDimension = z.number().nullish().transform((value) => value ?? undefined);
const TextConfigSchema = z.object({
  n_routed_experts: z.number().optional(), num_experts: z.number().optional(), num_local_experts: z.number().optional(),
  layer_types: z.array(z.string()).optional(),
  num_nextn_predict_layers: z.number().optional(), mtp_num_hidden_layers: z.number().optional(),
  ngram_size: z.number().optional(), kv_lora_rank: z.number().optional(),
  num_hidden_layers: OptionalDimension, num_attention_heads: OptionalDimension,
  num_key_value_heads: OptionalDimension, hidden_size: OptionalDimension, head_dim: OptionalDimension,
  linear_num_key_heads: OptionalDimension, linear_num_value_heads: OptionalDimension,
  linear_key_head_dim: OptionalDimension, linear_value_head_dim: OptionalDimension,
  linear_conv_kernel_dim: OptionalDimension,
});
const ModelConfigSchema = TextConfigSchema.extend({
  architectures: z.array(z.string()).nonempty(),
  text_config: TextConfigSchema.optional(),
  vision_config: z.object({}).passthrough().optional(),
});
const GenerationConfigSchema = z.object({
  temperature: z.number().optional(), top_p: z.number().optional(), top_k: z.number().optional(),
});
const TokenizerConfigSchema = z.object({ chat_template: z.string().optional() });

function readJsonFile<Schema extends z.ZodType>(path: string, schema: Schema): z.infer<Schema> {
  return schema.parse(parseJsonValueText(readFileSync(path, 'utf8')));
}

/** The chat template file, else the one embedded in tokenizer_config.json, else none. */
function readChatTemplate(modelDirectory: string): string {
  const templatePath = join(modelDirectory, 'chat_template.jinja');
  if (existsSync(templatePath)) return readFileSync(templatePath, 'utf8');
  const tokenizerPath = join(modelDirectory, 'tokenizer_config.json');
  return existsSync(tokenizerPath) ? readJsonFile(tokenizerPath, TokenizerConfigSchema).chat_template ?? '' : '';
}

function extractReasoningEfforts(template: string): ReasoningEffort[] {
  const quoted = new Set<string>();
  for (const line of template.split('\n')) {
    if (!line.includes('reasoning_effort')) continue;
    for (const match of line.matchAll(/['"]([a-z]+)['"]/gu)) quoted.add(match[1] ?? '');
  }
  return ReasoningEffortSchema.options.filter((effort) => quoted.has(effort));
}

export type TemplateThinking = Pick<ModelProfile, 'reasoningEfforts' | 'thinkingToggle' | 'preserveThinking'>;

function inspectTemplateThinking(template: string): TemplateThinking {
  // Without a template nothing is known to be ignored, so every thinking setting stays applicable.
  if (template === '') return { reasoningEfforts: [], thinkingToggle: true, preserveThinking: true };
  return {
    reasoningEfforts: extractReasoningEfforts(template),
    thinkingToggle: template.includes('enable_thinking'),
    preserveThinking: template.includes('preserve_thinking'),
  };
}

/** Which thinking kwargs the model's chat template honors. */
export function readTemplateThinking(modelDirectory: string): TemplateThinking {
  return inspectTemplateThinking(readChatTemplate(modelDirectory));
}

const isPositive = (value: number | undefined): boolean => (value ?? 0) > 0;

const KNOWN_LAYER_TYPES = new Set(['full_attention', 'sliding_attention', 'linear_attention']);
const LinearDimsSchema = z.object({
  linear_num_key_heads: z.number(), linear_num_value_heads: z.number(), linear_key_head_dim: z.number(),
  linear_value_head_dim: z.number(), linear_conv_kernel_dim: z.number(),
});
type TextConfig = z.infer<typeof TextConfigSchema>;

/** Bytes of one gated-delta-net layer's fp16 checkpoint: conv state plus recurrent state (exllamav3 get_checkpoint_size). */
function linearLayerSnapshotBytes(dims: z.infer<typeof LinearDimsSchema>): number {
  const qkvDim = 2 * dims.linear_num_key_heads * dims.linear_key_head_dim + dims.linear_num_value_heads * dims.linear_value_head_dim;
  return qkvDim * dims.linear_conv_kernel_dim * 2 + dims.linear_num_value_heads * dims.linear_key_head_dim * dims.linear_value_head_dim * 2;
}

function deriveCacheGeometry(text: TextConfig): CacheGeometry | string {
  if (isPositive(text.kv_lora_rank)) return 'MLA attention (kv_lora_rank) is not modelled';
  const unknownType = text.layer_types?.find((type) => !KNOWN_LAYER_TYPES.has(type));
  if (unknownType !== undefined) return `layer type '${unknownType}' is not modelled`;
  const layers = text.layer_types?.length ?? text.num_hidden_layers;
  if (layers === undefined) return 'config.json has no num_hidden_layers';
  // Hugging Face configs omit num_key_value_heads for plain multi-head attention.
  const kvHeads = text.num_key_value_heads ?? text.num_attention_heads;
  if (kvHeads === undefined) return 'config.json has no num_key_value_heads';
  const headDim = text.head_dim ?? (text.hidden_size !== undefined && text.num_attention_heads !== undefined
    ? text.hidden_size / text.num_attention_heads : undefined);
  if (headDim === undefined) return 'config.json has no head_dim';
  const linearLayers = text.layer_types?.filter((type) => type === 'linear_attention').length ?? 0;
  let recurrentSnapshotBytes = 0;
  if (linearLayers > 0) {
    const dims = LinearDimsSchema.safeParse(text);
    if (!dims.success) return `config.json has no ${String(dims.error.issues[0]?.path[0])}`;
    recurrentSnapshotBytes = linearLayers * linearLayerSnapshotBytes(dims.data);
  }
  return {
    attentionLayers: layers - linearLayers, kvTokenDim: kvHeads * headDim,
    mtpLayers: text.mtp_num_hidden_layers ?? text.num_nextn_predict_layers ?? 0, recurrentSnapshotBytes,
  };
}

function readModelConfig(modelDirectory: string): z.infer<typeof ModelConfigSchema> {
  const configPath = join(modelDirectory, 'config.json');
  if (!existsSync(configPath)) throw new Error(`${modelDirectory} has no config.json`);
  return readJsonFile(configPath, ModelConfigSchema);
}

/** The model's cache geometry from config.json alone, or why there is none; launch reads only this. */
export function readModelCacheGeometry(modelDirectory: string): CacheGeometry | string {
  const config = readModelConfig(modelDirectory);
  return deriveCacheGeometry(config.text_config ?? config);
}

export function inspectModelDirectory(modelDirectory: string): ModelProfile {
  const config = readModelConfig(modelDirectory);
  const text = config.text_config ?? config;
  const generationPath = join(modelDirectory, 'generation_config.json');
  const generation = existsSync(generationPath) ? readJsonFile(generationPath, GenerationConfigSchema) : {};
  return {
    name: basename(modelDirectory),
    architecture: config.architectures[0],
    moe: isPositive(text.n_routed_experts) || isPositive(text.num_experts) || isPositive(text.num_local_experts),
    recurrent: (text.layer_types ?? []).includes('linear_attention'),
    mtp: isPositive(text.num_nextn_predict_layers) || isPositive(text.mtp_num_hidden_layers),
    vision: config.vision_config !== undefined,
    ngram: isPositive(text.ngram_size),
    mla: isPositive(text.kv_lora_rank),
    ...readTemplateThinking(modelDirectory),
    sampling: {
      temperature: generation.temperature ?? null, topP: generation.top_p ?? null, topK: generation.top_k ?? null,
    },
    cacheGeometry: deriveCacheGeometry(text),
  };
}
