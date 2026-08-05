import { z } from '../../lib/zod.js';
import { SensitivitySchema, type Sensitivity } from '../domain/enums.js';

export interface ProjectionFrontmatter {
  readonly projectionId: string;
  readonly tier: 1 | 2 | 3;
  readonly topicKey: string;
  readonly generatedAtUtc: string;
  readonly graphVersion: number;
  readonly tokenizerId: string;
  readonly tokenCount: number;
  readonly sensitivity: Sensitivity;
  readonly includedAssertionIds: readonly string[];
}

const ParsedFrontmatterSchema = z.object({
  projectionId: z.string(),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  topicKey: z.string(),
  generatedAtUtc: z.string(),
  graphVersion: z.number().int(),
  tokenizerId: z.string(),
  tokenCount: z.number().int(),
  sensitivity: SensitivitySchema,
  includedAssertionIds: z.array(z.string()),
});

const FIELD_KEYS = [
  'projection_id', 'tier', 'topic_key', 'generated_at', 'graph_version',
  'tokenizer_id', 'token_count', 'sensitivity', 'included_assertion_ids',
] as const;

/** §10.1. A fixed key order so an unchanged projection produces byte-identical output. */
export function renderFrontmatter(input: ProjectionFrontmatter): string {
  return [
    '---',
    'generated: true',
    'do_not_edit: true',
    `projection_id: ${input.projectionId}`,
    `tier: ${input.tier}`,
    `topic_key: ${input.topicKey}`,
    `generated_at: ${input.generatedAtUtc}`,
    `graph_version: ${input.graphVersion}`,
    `tokenizer_id: ${input.tokenizerId}`,
    `token_count: ${input.tokenCount}`,
    `sensitivity: ${input.sensitivity}`,
    `included_assertion_ids: [${input.includedAssertionIds.join(', ')}]`,
    '---',
  ].join('\n');
}

export function parseFrontmatter(document: string): ProjectionFrontmatter {
  const values = new Map<string, string>();
  for (const line of document.split('\n')) {
    if (line === '---') continue;
    const separator = line.indexOf(': ');
    if (separator < 0) break;
    values.set(line.slice(0, separator), line.slice(separator + 2));
  }
  for (const key of FIELD_KEYS) {
    if (!values.has(key)) {
      throw new Error(`Projection frontmatter is missing ${key}.`);
    }
  }
  const idList = (values.get('included_assertion_ids') ?? '[]')
    .replace(/^\[/, '').replace(/\]$/, '')
    .split(',').map((value) => value.trim()).filter((value) => value.length > 0);
  return ParsedFrontmatterSchema.parse({
    projectionId: values.get('projection_id'),
    tier: Number.parseInt(values.get('tier') ?? '', 10),
    topicKey: values.get('topic_key'),
    generatedAtUtc: values.get('generated_at'),
    graphVersion: Number.parseInt(values.get('graph_version') ?? '', 10),
    tokenizerId: values.get('tokenizer_id'),
    tokenCount: Number.parseInt(values.get('token_count') ?? '', 10),
    sensitivity: values.get('sensitivity'),
    includedAssertionIds: idList,
  });
}