import { z } from '../lib/zod.js';
import {
  ApprovalModeSchema,
  type ApprovalMode,
} from '../repo-search/engine/approval-gate.js';

export const RepoAgentStartInvocationSchema = z.object({
  kind: z.literal('start'),
  task: z.string().trim().min(1),
  taskTokenCount: z.number().int().min(1),
  model: z.string().min(1).optional(),
  logFile: z.string().min(1).optional(),
  approval: ApprovalModeSchema,
  progress: z.boolean(),
  images: z.array(z.string().min(1)).default([]),
});
export type RepoAgentStartInvocation = z.infer<
  typeof RepoAgentStartInvocationSchema
>;

export const RepoAgentDecisionKindSchema = z.enum(['approve', 'deny', 'abort']);

export const RepoAgentDecideInvocationSchema = z.object({
  kind: z.literal('decide'),
  runId: z.string().uuid(),
  decision: RepoAgentDecisionKindSchema,
  reason: z.string().trim().min(1).optional(),
  progress: z.boolean(),
});

export const RepoAgentStatusInvocationSchema = z.object({
  kind: z.literal('status'),
  runId: z.string().uuid(),
});

export const RepoAgentInvocationSchema = z.discriminatedUnion('kind', [
  RepoAgentStartInvocationSchema,
  RepoAgentDecideInvocationSchema,
  RepoAgentStatusInvocationSchema,
]);
export type RepoAgentInvocation = z.infer<typeof RepoAgentInvocationSchema>;

function readOptionValue(tokens: string[], index: number, option: string): string {
  const value = tokens[index + 1];
  if (value === undefined || value.startsWith('-')) {
    throw new Error(`Missing value for ${option}.`);
  }
  return value;
}

function parseRunId(raw: string): string {
  const parsed = z.string().uuid().safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid run ID: ${raw}. Expected a valid UUID.`);
  }
  return parsed.data;
}

export function parseRepoAgentInvocation(tokens: string[]): RepoAgentInvocation {
  for (const token of tokens) {
    if (token === '--prompt' || token === '-prompt') {
      throw new Error(`${token} is not supported for repo-agent. Use a positional task instead.`);
    }
  }

  if (tokens[0] === 'decide') {
    return parseDecideInvocation(tokens);
  }
  if (tokens[0] === 'status') {
    return parseStatusInvocation(tokens);
  }
  return parseStartInvocation(tokens);
}

function parseStartInvocation(tokens: string[]): RepoAgentInvocation {
  const taskTokens: string[] = [];
  let model: string | undefined;
  let logFile: string | undefined;
  let approval: ApprovalMode = 'auto';
  let progress = false;
  const images: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--model') {
      model = readOptionValue(tokens, index, token);
      index += 1;
      continue;
    }
    if (token === '--log-file') {
      logFile = readOptionValue(tokens, index, token);
      index += 1;
      continue;
    }
    if (token === '--approval') {
      const raw = readOptionValue(tokens, index, token);
      const parsed = ApprovalModeSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(`Invalid --approval value: ${raw}. Expected interactive, auto, or off.`);
      }
      approval = parsed.data;
      index += 1;
      continue;
    }
    if (token === '--image') {
      images.push(readOptionValue(tokens, index, token));
      index += 1;
      continue;
    }
    if (token === '--progress') {
      progress = true;
      continue;
    }
    if (token.startsWith('-')) {
      throw new Error(`Unknown option: ${token}.`);
    }
    taskTokens.push(token);
  }

  const task = taskTokens.filter((token) => token.length > 0).join(' ');
  if (task.length === 0) {
    throw new Error('No task provided. Usage: siftkit repo-agent "task"');
  }

  const invocation = {
    kind: 'start',
    task,
    taskTokenCount: taskTokens.length,
    approval,
    progress,
    images,
  } as const;
  if (model !== undefined && logFile !== undefined) {
    return RepoAgentStartInvocationSchema.parse({ ...invocation, model, logFile });
  }
  if (model !== undefined) {
    return RepoAgentStartInvocationSchema.parse({ ...invocation, model });
  }
  if (logFile !== undefined) {
    return RepoAgentStartInvocationSchema.parse({ ...invocation, logFile });
  }
  return RepoAgentStartInvocationSchema.parse(invocation);
}

function parseDecideInvocation(tokens: string[]): RepoAgentInvocation {
  const rawRunId = tokens[1];
  if (rawRunId === undefined) {
    throw new Error('decide requires a run ID.');
  }
  const runId = parseRunId(rawRunId);

  const rawDecision = tokens[2];
  if (rawDecision === undefined) {
    throw new Error('decide requires a decision (approve, deny, or abort).');
  }
  const parsedDecision = RepoAgentDecisionKindSchema.safeParse(rawDecision);
  if (!parsedDecision.success) {
    throw new Error(`Invalid decision: ${rawDecision}. Expected approve, deny, or abort.`);
  }
  const decision = parsedDecision.data;

  let reason: string | undefined;
  let progress = false;
  for (let index = 3; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--reason') {
      if (decision !== 'deny') {
        throw new Error(`${decision} does not accept --reason.`);
      }
      reason = readOptionValue(tokens, index, token);
      index += 1;
      continue;
    }
    if (token === '--progress') {
      progress = true;
      continue;
    }
    if (token.startsWith('-')) {
      throw new Error(`Unknown option: ${token}.`);
    }
    throw new Error(`Unexpected extra token after decide: ${token}.`);
  }

  if (decision === 'deny' && (reason === undefined || reason.trim().length === 0)) {
    throw new Error('deny requires --reason with a non-empty value.');
  }

  const invocation = {
    kind: 'decide',
    runId,
    decision,
    progress,
  } as const;
  return RepoAgentDecideInvocationSchema.parse(
    reason === undefined ? invocation : { ...invocation, reason },
  );
}

function parseStatusInvocation(tokens: string[]): RepoAgentInvocation {
  const rawRunId = tokens[1];
  if (rawRunId === undefined) {
    throw new Error('status requires a run ID.');
  }
  const runId = parseRunId(rawRunId);
  const extra = tokens[2];
  if (extra !== undefined) {
    throw new Error(`Unexpected extra token after status: ${extra}.`);
  }

  return RepoAgentStatusInvocationSchema.parse({
    kind: 'status',
    runId,
  });
}
