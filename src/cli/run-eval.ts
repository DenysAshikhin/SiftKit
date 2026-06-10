import { formatPsList, getCommandArgs, parseArguments } from './args.js';
import { StatusServerApiClient } from './status-server-api-client.js';

export async function runEvalCli(options: {
  argv: string[];
  stdout: NodeJS.WritableStream;
}): Promise<number> {
  const parsed = parseArguments(getCommandArgs(options.argv));
  const result = await new StatusServerApiClient().runEvaluation({
    FixtureRoot: parsed.fixtureRoot,
    Backend: parsed.backend,
    Model: parsed.model,
  });
  options.stdout.write(formatPsList(result));
  return 0;
}
