import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { ReasoningEffortSchema, type ModelProfile, type ReasoningEffort } from '@siftkit/contracts';
import { parseJsonValueText } from '../lib/json.ts';

const TextConfigSchema = z.object({
  n_routed_experts: z.number().optional(), num_experts: z.number().optional(), num_local_experts: z.number().optional(),
  layer_types: z.array(z.string()).optional(),
  num_nextn_predict_layers: z.number().optional(), mtp_num_hidden_layers: z.number().optional(),
  ngram_size: z.number().optional(), kv_lora_rank: z.number().optional(),
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

export function inspectModelDirectory(modelDirectory: string): ModelProfile {
  const configPath = join(modelDirectory, 'config.json');
  if (!existsSync(configPath)) throw new Error(`${modelDirectory} has no config.json`);
  const config = readJsonFile(configPath, ModelConfigSchema);
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
  };
}
