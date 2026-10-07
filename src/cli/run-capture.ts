import { resolveExternalCommand } from '../capture/command-path.ts';
import { captureWithTranscript } from '../capture/process.ts';
import { parseArguments, type ResolvedCliArgs } from './args.ts';
import { normalizeCliFormat, normalizeCliPolicyProfile } from './request-normalizers.ts';
import { CliProgressRenderer } from './progress-renderer.ts';
import { StatusServerApiClient } from './status-server-api-client.ts';

export async function runCaptureInternalCli(options: ResolvedCliArgs & {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}): Promise<number> {
  const parsed = parseArguments(options.args);
  const command = parsed.command || parsed.positionals[0];
  if (!command) {
    throw new Error('A command is required.');
  }

  const argList = (parsed.argList && parsed.argList.length > 0)
    ? parsed.argList
    : parsed.positionals.slice(1);
  const captured = captureWithTranscript(resolveExternalCommand(command), argList);
  const fallbackTranscript = `Interactive command completed without a captured transcript.\nCommand: ${command} ${argList.join(' ')}\nExitCode: ${captured.ExitCode}`;
  const result = await new StatusServerApiClient().analyzeCommandOutput({
    repoRoot: process.cwd(),
    outputKind: 'interactive',
    exitCode: captured.ExitCode,
    combinedText: captured.Transcript.trim() ? captured.Transcript : fallbackTranscript,
    commandText: [command, ...argList].join(' '),
    question: parsed.question,
    format: normalizeCliFormat(parsed.format),
    policyProfile: normalizeCliPolicyProfile(parsed.profile),
    provider: parsed.provider,
    model: parsed.model,
  }, CliProgressRenderer.forCli(options.stderr, 'capture', parsed.progress === true));
  options.stdout.write(`${String(result.Summary || 'No summary generated.').trim()}\nRaw transcript: ${result.RawLogPath}\n`);
  return 0;
}
