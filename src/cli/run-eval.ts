import { formatPsList, parseArguments } from './args.js';
import { SilentProgressRenderer } from './progress-renderer.js';
import { StatusServerApiClient } from './status-server-api-client.js';

export async function runEvalCli(options: {
  args: string[];
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}): Promise<number> {
  const parsed = parseArguments(options.args);
  const result = await new StatusServerApiClient().runEvaluation({
    FixtureRoot: parsed.fixtureRoot,
    Backend: parsed.backend,
    Model: parsed.model,
  }, new SilentProgressRenderer(options.stderr, 'eval'));
  options.stdout.write(formatPsList(result));
  return 0;
}
