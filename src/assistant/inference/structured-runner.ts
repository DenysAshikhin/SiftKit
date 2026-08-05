import { z } from '../../lib/zod.js';
import { parseJsonObjectText } from '../../lib/json.js';
import type { JsonObject } from '../../lib/json-types.js';
import { JsonObjectSchema } from '../../lib/json-types.js';
import type { AssistantInferenceClient } from './client.js';
import { ROLE_PROMPT_VERSION, buildRoleSystemPrompt, type AssistantInferenceRole } from './roles.js';

export interface StructuredRunRequest<T> {
  readonly role: AssistantInferenceRole;
  readonly instructions: string;
  readonly userText: string;
  readonly schemaName: string;
  readonly schema: z.ZodType<T>;
  readonly abortSignal: AbortSignal | null;
}

export type StructuredRunFailureCode = 'invalid_json' | 'schema_invalid';

export type StructuredRunOutcome<T> =
  | {
      readonly ok: true;
      readonly value: T;
      readonly backendId: string;
      readonly modelId: string;
      readonly promptVersion: string;
      readonly attempts: number;
    }
  | {
      readonly ok: false;
      readonly code: StructuredRunFailureCode;
      readonly message: string;
      readonly attempts: number;
    };

type ParseAttempt<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: StructuredRunFailureCode;
      readonly message: string;
    };

/**
 * Runs one model role and validates its answer against a zod schema. Exactly one repair retry
 * (§8.2): the second attempt is shown what was wrong and is re-validated from scratch.
 */
export class StructuredOutputRunner {
  constructor(private readonly client: AssistantInferenceClient) {}

  async run<T>(request: StructuredRunRequest<T>): Promise<StructuredRunOutcome<T>> {
    const systemPrompt = buildRoleSystemPrompt(request.role, request.instructions);
    const responseJsonSchema = this.toJsonSchema(request.schema);

    const first = await this.client.complete({
      role: request.role,
      systemPrompt,
      userText: request.userText,
      responseSchemaName: request.schemaName,
      responseJsonSchema,
      abortSignal: request.abortSignal,
    });
    const firstParse = this.parse(first.text, request.schema);
    if (firstParse.ok) {
      return {
        ok: true, value: firstParse.value, backendId: first.backendId, modelId: first.modelId,
        promptVersion: ROLE_PROMPT_VERSION[request.role], attempts: 1,
      };
    }

    const second = await this.client.complete({
      role: request.role,
      systemPrompt,
      userText: this.buildRepairText(request.userText, first.text, firstParse.message),
      responseSchemaName: request.schemaName,
      responseJsonSchema,
      abortSignal: request.abortSignal,
    });
    const secondParse = this.parse(second.text, request.schema);
    if (secondParse.ok) {
      return {
        ok: true, value: secondParse.value, backendId: second.backendId, modelId: second.modelId,
        promptVersion: ROLE_PROMPT_VERSION[request.role], attempts: 2,
      };
    }
    return { ok: false, code: secondParse.code, message: secondParse.message, attempts: 2 };
  }

  private parse<T>(text: string, schema: z.ZodType<T>): ParseAttempt<T> {
    const trimmed = text.trim();
    const parsed = this.safeJson(trimmed);
    if (parsed === null) {
      return { ok: false, code: 'invalid_json', message: 'The response was not valid JSON.' };
    }
    const validated = schema.safeParse(parsed);
    if (!validated.success) {
      return {
        ok: false, code: 'schema_invalid',
        message: validated.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; '),
      };
    }
    return { ok: true, value: validated.data };
  }

  private safeJson(text: string): JsonObject | null {
    try {
      return parseJsonObjectText(text);
    } catch {
      return null;
    }
  }

  private buildRepairText(originalText: string, badResponse: string, problem: string): string {
    return [
      'Your previous answer was rejected.',
      `Problem: ${problem}`,
      'Rejected answer:',
      badResponse,
      '',
      'Produce a corrected answer for the same content. Output JSON only.',
      '',
      originalText,
    ].join('\n');
  }

  private toJsonSchema<T>(schema: z.ZodType<T>): JsonObject {
    const generated = JsonObjectSchema.safeParse(z.toJSONSchema(schema));
    if (!generated.success) {
      throw new Error('Failed to derive a JSON schema for a structured assistant response.');
    }
    return generated.data;
  }
}