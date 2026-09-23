import { ApprovalModeSchema, DEFAULT_APPROVAL_MODE, type ApprovalMode } from '@siftkit/contracts';

import { z } from '../lib/zod.js';

const RunIdSchema = z.string().uuid();

export const OrchestratorInvocationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('start'), task: z.string().trim().min(1).nullable(), planPath: z.string().trim().min(1).nullable(),
    presetId: z.string().trim().min(1), approval: ApprovalModeSchema, repoRoot: z.string().min(1) }).strict()
    .refine((invocation) => invocation.task !== null || invocation.planPath !== null, {
      message: 'siftkit orchestrator needs a task, --plan <path>, or both.',
    }),
  z.object({ kind: z.literal('attach'), runId: RunIdSchema, afterSequence: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('status'), runId: RunIdSchema }).strict(),
  z.object({ kind: z.literal('abort'), runId: RunIdSchema }).strict(),
  z.object({ kind: z.literal('decide'), runId: RunIdSchema, approvalId: RunIdSchema,
    decision: z.enum(['approve', 'deny', 'abort']), reason: z.string().trim().min(1).nullable() }).strict()
    .refine((invocation) => invocation.decision !== 'deny' || invocation.reason !== null, { message: 'deny requires --reason "<why>".' }),
]);
export type OrchestratorInvocation = z.infer<typeof OrchestratorInvocationSchema>;

function readValue(tokens: readonly string[], index: number, option: string): string {
  const value = tokens[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${option}.`);
  return value;
}

function parseRunId(raw: string | undefined): string {
  const parsed = RunIdSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid orchestrator run ID: ${raw ?? '(missing)'}. Expected a UUID.`);
  return parsed.data;
}

function parseOrThrow(candidate: z.input<typeof OrchestratorInvocationSchema>): OrchestratorInvocation {
  const parsed = OrchestratorInvocationSchema.safeParse(candidate);
  if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => issue.message).join(' '));
  return parsed.data;
}

/** `siftkit orchestrator` subcommands; anything that is not a control verb starts a run. */
export function parseOrchestratorInvocation(tokens: readonly string[], cwd: string): OrchestratorInvocation {
  const [verb, first, second, third] = tokens;
  if (verb === 'status' || verb === 'abort') return parseOrThrow({ kind: verb, runId: parseRunId(first) });
  if (verb === 'attach') {
    const afterIndex = tokens.indexOf('--after');
    const after = afterIndex < 0 ? '0' : readValue(tokens, afterIndex, '--after');
    if (!/^\d+$/u.test(after)) throw new Error(`Invalid --after value: ${after}. Expected a nonnegative integer.`);
    return parseOrThrow({ kind: 'attach', runId: parseRunId(first), afterSequence: Number(after) });
  }
  if (verb === 'decide') {
    const reasonIndex = tokens.indexOf('--reason');
    return parseOrThrow({ kind: 'decide', runId: parseRunId(first), approvalId: parseRunId(second),
      decision: z.enum(['approve', 'deny', 'abort']).parse(third),
      reason: reasonIndex < 0 ? null : readValue(tokens, reasonIndex, '--reason') });
  }
  const taskTokens: string[] = [];
  let planPath: string | null = null;
  let presetId = 'orchestrator';
  let approval: ApprovalMode = DEFAULT_APPROVAL_MODE;
  let repoRoot = cwd;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (token === '--plan' || token === '--preset' || token === '--approval' || token === '--repo') {
      const value = readValue(tokens, index, token);
      index += 1;
      if (token === '--plan') planPath = value;
      else if (token === '--preset') presetId = value;
      else if (token === '--repo') repoRoot = value;
      else {
        const parsed = ApprovalModeSchema.safeParse(value);
        if (!parsed.success) throw new Error(`Invalid --approval value: ${value}. Expected interactive, auto, or off.`);
        approval = parsed.data;
      }
      continue;
    }
    if (token.startsWith('--')) throw new Error(`Unknown orchestrator option: ${token}.`);
    taskTokens.push(token);
  }
  const task = taskTokens.join(' ').trim();
  return parseOrThrow({ kind: 'start', task: task.length === 0 ? null : task, planPath, presetId, approval, repoRoot });
}
