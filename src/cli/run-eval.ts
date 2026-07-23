import { formatPsList, parseArguments } from './args.js';
import { CLI_COMMAND_CATALOG } from './command-catalog.js';
import { SilentProgressRenderer } from './progress-renderer.js';
import { StatusServerApiClient } from './status-server-api-client.js';

export async function runEvalCli(options: {
  argv: string[];
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}): Promise<number> {
  const parsed = parseArguments(CLI_COMMAND_CATALOG.resolve(options.argv).args);
  const result = await new StatusServerApiClient().runEvaluation({
    FixtureRoot: parsed.fixtureRoot,
    Backend: parsed.backend,
    Model: parsed.model,
  }, new SilentProgressRenderer(options.stderr, 'eval'));
  options.stdout.write(formatPsList(result));
  return 0;
}
