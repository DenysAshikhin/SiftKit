import { z } from '../../lib/zod.js';
import { JsonObjectSchema, JsonValueSchema } from '../../lib/json-types.js';
import { EvidenceSourceTypeSchema, SensitivitySchema } from '../domain/enums.js';

/**
 * §7.1. Gate B carries text and json payloads; the blob payload arrives with Gate D capture,
 * which is the first caller that can produce one.
 */
export const IngestionEnvelopeSchema = z.object({
  ownerId: z.string(),
  deviceId: z.string().nullable(),
  sourceType: EvidenceSourceTypeSchema,
  /** Idempotency key for re-ingestion: the same event never produces two evidence rows. */
  sourceEventId: z.string().min(1),
  sourceRef: z.string().nullable(),
  capturedAtUtc: z.string(),
  sourceTimezone: z.string().nullable(),
  /**
   * The source's own classification, used as a floor the secret scan can only raise. Null when
   * the source cannot classify itself, which is every local source: only the mobile envelope
   * carries a signed sensitivity.
   */
  declaredSensitivity: SensitivitySchema.nullable(),
  payload: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('text'), text: z.string() }),
    z.object({ kind: z.literal('json'), value: JsonValueSchema }),
    z.object({
      kind: z.literal('question_answer'),
      questionId: z.string().min(1),
      text: z.string(),
    }).strict(),
  ]),
  metadata: JsonObjectSchema,
}).strict();

export type IngestionEnvelope = z.infer<typeof IngestionEnvelopeSchema>;
