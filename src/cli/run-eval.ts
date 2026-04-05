import { runEvaluation } from '../eval.js';
import { formatPsList, getCommandArgs, parseArguments } from './args.js';

export async function runEvalCli(options: {
  argv: string[];
  stdout: NodeJS.WritableStream;
}): Promise<number> {
  const parsed = parseArguments(getCommandArgs(options.argv));
  const result = await runEvaluation({
    FixtureRoot: parsed.fixtureRoot,
    Backend: parsed.backend,
    Model: parsed.model,
  });
  options.stdout.write(formatPsList(result));
  return 0;
}
