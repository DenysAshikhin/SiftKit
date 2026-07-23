import { ensureStatusServerReachable } from '../config/index.js';
import { invokeProcess, invokeShellProcess } from '../capture/process.js';
import { getCommandArgs, parseArguments } from './args.js';
import {
  normalizeCliFormat,
  normalizeCliPolicyProfile,
  normalizeCliReducerProfile,
  normalizeCliRiskLevel,
  normalizeCliShell,
} from './request-normalizers.js';
import { CliProgressRenderer } from './progress-renderer.js';
import { StatusServerApiClient } from './status-server-api-client.js';

export async function runCommandCli(options: {
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
  const shell = normalizeCliShell(parsed.shell);
  if (parsed.shell && !shell) {
    throw new Error(`Unsupported shell: ${parsed.shell}`);
  }

  await ensureStatusServerReachable();
  const processResult = shell
    ? invokeShellProcess(command, shell)
    : invokeProcess(command, argList);
  const result = await new StatusServerApiClient().analyzeCommandOutput({
    outputKind: 'command',
    exitCode: processResult.ExitCode,
    combinedText: processResult.Combined,
    commandText: shell ? `[${shell}] ${command}` : [command, ...argList].join(' '),
    question: parsed.question,
    riskLevel: normalizeCliRiskLevel(parsed.risk),
    reducerProfile: normalizeCliReducerProfile(parsed.reducer),
    format: normalizeCliFormat(parsed.format),
    policyProfile: normalizeCliPolicyProfile(parsed.profile),
    backend: parsed.backend,
    model: parsed.model,
    shell,
  }, CliProgressRenderer.forCli(options.stderr, 'run', parsed.progress === true));

  if (result.Summary) {
    options.stdout.write(`${result.Summary}\n`);
  } else {
    options.stdout.write('No summary generated.\n');
  }
  options.stdout.write(`Raw log: ${result.RawLogPath}\n`);
  return 0;
}
