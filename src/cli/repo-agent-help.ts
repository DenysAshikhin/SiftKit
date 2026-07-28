import { z } from '../lib/zod.js';

export const RepoAgentHelpTopicSchema = z.enum(['root', 'decide', 'status']);

const RepoAgentHelpCommandSchema = z.object({
  name: z.enum(['start', 'decide', 'status']),
  synopsis: z.string(),
  arguments: z.array(z.string()),
});

const RepoAgentHelpOptionSchema = z.object({
  name: z.string(),
  value: z.string().nullable(),
  default: z.string().nullable(),
  description: z.string(),
});

const RepoAgentHelpResultSchema = z.object({
  status: z.enum(['completed', 'approval_required', 'failed', 'aborted']),
  exitCode: z.number().int(),
  meaning: z.string(),
});

export const RepoAgentHelpSchema = z.object({
  command: z.literal('repo-agent'),
  topic: RepoAgentHelpTopicSchema,
  canonicalInvocation: z.literal('siftkit repo-agent "task" [options]'),
  defaultApproval: z.literal('auto'),
  ttyMode: z.literal('foreground-interactive'),
  nonTtyMode: z.literal('resumable-json'),
  commands: z.array(RepoAgentHelpCommandSchema),
  options: z.array(RepoAgentHelpOptionSchema),
  resultStatuses: z.tuple([
    z.literal('completed'),
    z.literal('approval_required'),
    z.literal('failed'),
    z.literal('aborted'),
  ]),
  results: z.array(RepoAgentHelpResultSchema),
  examples: z.array(z.string()),
});
export type RepoAgentHelp = z.infer<typeof RepoAgentHelpSchema>;
export type RepoAgentHelpTopic = z.infer<typeof RepoAgentHelpTopicSchema>;

export const RepoAgentHelpInvocationSchema = z.object({
  topic: RepoAgentHelpTopicSchema,
  json: z.boolean(),
});
export type RepoAgentHelpInvocation = z.infer<typeof RepoAgentHelpInvocationSchema>;

const ROOT_HELP = RepoAgentHelpSchema.parse({
  command: 'repo-agent',
  topic: 'root',
  canonicalInvocation: 'siftkit repo-agent "task" [options]',
  defaultApproval: 'auto',
  ttyMode: 'foreground-interactive',
  nonTtyMode: 'resumable-json',
  commands: [
    {
      name: 'start',
      synopsis: 'siftkit repo-agent "task" [options]',
      arguments: ['task'],
    },
    {
      name: 'decide',
      synopsis: 'siftkit repo-agent decide <run-id> <approve|deny|abort> [--reason <text>]',
      arguments: ['run-id', 'decision'],
    },
    {
      name: 'status',
      synopsis: 'siftkit repo-agent status <run-id>',
      arguments: ['run-id'],
    },
  ],
  options: [
    { name: '--model', value: '<model>', default: null, description: 'Select the model.' },
    { name: '--log-file', value: '<path>', default: null, description: 'Write the session log.' },
    {
      name: '--approval',
      value: '<interactive|auto|off>',
      default: 'auto',
      description: 'Set approval handling.',
    },
    { name: '--progress', value: null, default: 'false', description: 'Show progress output.' },
    { name: '--help', value: null, default: null, description: 'Show help.' },
    { name: '--json', value: null, default: null, description: 'Emit structured help.' },
  ],
  resultStatuses: ['completed', 'approval_required', 'failed', 'aborted'],
  results: [
    { status: 'completed', exitCode: 0, meaning: 'Task completed.' },
    { status: 'approval_required', exitCode: 0, meaning: 'A decision is required.' },
    { status: 'failed', exitCode: 1, meaning: 'Task failed.' },
    { status: 'aborted', exitCode: 1, meaning: 'Task was aborted.' },
  ],
  examples: [
    'siftkit repo-agent "fix the login bug"',
    'siftkit repo-agent status <run-id>',
    'siftkit repo-agent decide <run-id> approve',
    'siftkit repo-agent decide <run-id> deny --reason "out of scope"',
    'siftkit repo-agent decide <run-id> abort',
    'siftkit repo-agent --help --json',
  ],
});

const DECIDE_HELP = RepoAgentHelpSchema.parse({
  ...ROOT_HELP,
  topic: 'decide',
});

const STATUS_HELP = RepoAgentHelpSchema.parse({
  ...ROOT_HELP,
  topic: 'status',
});

function isHelpFlag(token: string): boolean {
  return token === '-h' || token === '--h' || token === '--help' || token === '-help';
}

function parseHelpTail(tokens: string[]): boolean | null {
  let foundHelp = false;
  let json = false;
  for (const token of tokens) {
    if (isHelpFlag(token) || token === 'help') {
      if (foundHelp) {
        return null;
      }
      foundHelp = true;
      continue;
    }
    if (token === '--json') {
      if (json) {
        return null;
      }
      json = true;
      continue;
    }
    return null;
  }
  return foundHelp ? json : null;
}

export function detectRepoAgentHelpInvocation(argv: string[]): RepoAgentHelpInvocation | null {
  if (argv[0] === 'help' && argv[1] === 'repo-agent') {
    const json = parseHelpTail(['help', ...argv.slice(2)]);
    return json === null ? null : RepoAgentHelpInvocationSchema.parse({ topic: 'root', json });
  }
  if (argv[0] !== 'repo-agent') {
    return null;
  }

  const subcommand = argv[1];
  if (subcommand === 'decide' || subcommand === 'status') {
    const json = parseHelpTail(argv.slice(2));
    return json === null
      ? null
      : RepoAgentHelpInvocationSchema.parse({ topic: subcommand, json });
  }

  const json = parseHelpTail(argv.slice(1));
  return json === null ? null : RepoAgentHelpInvocationSchema.parse({ topic: 'root', json });
}

function selectHelp(topic: RepoAgentHelpTopic): RepoAgentHelp {
  if (topic === 'decide') {
    return DECIDE_HELP;
  }
  if (topic === 'status') {
    return STATUS_HELP;
  }
  return ROOT_HELP;
}

function selectHelpCommand(descriptor: RepoAgentHelp): string {
  for (const command of descriptor.commands) {
    if (descriptor.topic === 'root' && command.name === 'start') {
      return command.synopsis;
    }
    if (command.name === descriptor.topic) {
      return command.synopsis;
    }
  }
  throw new Error(`Missing help command for ${descriptor.topic}.`);
}

export function showRepoAgentHelp(options: {
  stdout: NodeJS.WritableStream;
  invocation: RepoAgentHelpInvocation;
}): void {
  const descriptor = selectHelp(options.invocation.topic);
  if (options.invocation.json) {
    options.stdout.write(`${JSON.stringify(descriptor, null, 2)}\n`);
    return;
  }

  const lines = [
    `Usage: ${selectHelpCommand(descriptor)}`,
    '',
    `Default approval: ${descriptor.defaultApproval}`,
    `TTY mode: ${descriptor.ttyMode}`,
    `Non-TTY mode: ${descriptor.nonTtyMode}`,
  ];
  if (descriptor.topic === 'root') {
    lines.push('', 'Commands:');
    for (const command of descriptor.commands) {
      lines.push(`  ${command.synopsis}`);
    }
  }
  lines.push('', 'Options:');
  for (const option of descriptor.options) {
    const value = option.value === null ? '' : ` ${option.value}`;
    const defaultValue = option.default === null ? '' : ` (default: ${option.default})`;
    lines.push(`  ${option.name}${value}  ${option.description}${defaultValue}`);
  }
  lines.push('', 'Results:');
  for (const result of descriptor.results) {
    lines.push(`  ${result.status}: exit ${result.exitCode}. ${result.meaning}`);
  }
  lines.push('', 'Examples:');
  for (const example of descriptor.examples) {
    lines.push(`  ${example}`);
  }
  lines.push('');
  options.stdout.write(lines.join('\n'));
}
