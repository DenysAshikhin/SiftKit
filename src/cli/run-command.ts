import { runCommand } from '../command.js';
import { summarizeRequest } from '../summary/core.js';
import { getCommandArgs, parseArguments } from './args.js';

export async function runCommandCli(options: {
  argv: string[];
  stdout: NodeJS.WritableStream;
}): Promise<number> {
  const parsed = parseArguments(getCommandArgs(options.argv));
  const command = parsed.command || parsed.positionals[0];
  if (!command) {
    throw new Error('A command is required.');
  }

  const argList = (parsed.argList && parsed.argList.length > 0)
    ? parsed.argList
    : parsed.positionals.slice(1);
  const result = await runCommand({
    Command: command,
    ArgumentList: argList,
    Question: parsed.question,
    RiskLevel: parsed.risk,
    ReducerProfile: parsed.reducer,
    Format: parsed.format === 'json' ? 'json' : 'text',
    PolicyProfile: (parsed.profile as Parameters<typeof summarizeRequest>[0]['policyProfile']) || 'general',
    Backend: parsed.backend,
    Model: parsed.model,
  });

  if (result.Summary) {
    options.stdout.write(`${result.Summary}\n`);
  } else {
    options.stdout.write('No summary generated.\n');
  }
  options.stdout.write(`Raw log: ${result.RawLogPath}\n`);
  return 0;
}
