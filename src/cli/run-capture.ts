import { runInteractiveCapture } from '../interactive.js';
import { summarizeRequest } from '../summary.js';
import { getCommandArgs, parseArguments } from './args.js';

export async function runCaptureInternalCli(options: {
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
  const result = await runInteractiveCapture({
    Command: command,
    ArgumentList: argList,
    Question: parsed.question,
    Format: parsed.format === 'json' ? 'json' : 'text',
    PolicyProfile: (parsed.profile as Parameters<typeof summarizeRequest>[0]['policyProfile']) || 'general',
    Backend: parsed.backend,
    Model: parsed.model,
  });
  options.stdout.write(`${String(result.OutputText)}\n`);
  return 0;
}
