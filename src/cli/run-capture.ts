import { resolveExternalCommand } from '../capture/command-path.js';
import { captureWithTranscript } from '../capture/process.js';
import { getCommandArgs, parseArguments } from './args.js';
import { normalizeCliFormat, normalizeCliPolicyProfile } from './request-normalizers.js';
import { CliProgressRenderer } from './progress-renderer.js';
import { StatusServerApiClient } from './status-server-api-client.js';

export async function runCaptureInternalCli(options: {
  argv: string[];
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}): Promise<number> {
  const parsed = parseArguments(getCommandArgs(options.argv));
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
    outputKind: 'interactive',
    exitCode: captured.ExitCode,
    combinedText: captured.Transcript.trim() ? captured.Transcript : fallbackTranscript,
    commandText: [command, ...argList].join(' '),
    question: parsed.question,
    format: normalizeCliFormat(parsed.format),
    policyProfile: normalizeCliPolicyProfile(parsed.profile),
    backend: parsed.backend,
    model: parsed.model,
  }, new CliProgressRenderer(options.stderr, 'capture'));
  options.stdout.write(`${String(result.Summary || 'No summary generated.').trim()}\nRaw transcript: ${result.RawLogPath}\n`);
  return 0;
}
