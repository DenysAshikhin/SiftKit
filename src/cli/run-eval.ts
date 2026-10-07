import { formatPsList, parseArguments, type ResolvedCliArgs } from './args.ts';
import { SilentProgressRenderer } from './progress-renderer.ts';
import { StatusServerApiClient } from './status-server-api-client.ts';

export async function runEvalCli(options: ResolvedCliArgs & {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}): Promise<number> {
  const parsed = parseArguments(options.args);
  const result = await new StatusServerApiClient().runEvaluation({
    FixtureRoot: parsed.fixtureRoot,
    Provider: parsed.provider,
    Model: parsed.model,
  }, new SilentProgressRenderer(options.stderr, 'eval'));
  options.stdout.write(formatPsList(result));
  return 0;
}
