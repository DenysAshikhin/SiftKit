import { installCodexPolicy, installShellIntegration, installSiftKit } from '../install.js';
import { formatPsList, getCommandArgs, parseArguments } from './args.js';

export async function runInstall(stdout: NodeJS.WritableStream): Promise<number> {
  const result = await installSiftKit(false);
  stdout.write(formatPsList(result));
  return 0;
}

export async function runCodexPolicyCli(options: {
  argv: string[];
  stdout: NodeJS.WritableStream;
}): Promise<number> {
  const parsed = parseArguments(getCommandArgs(options.argv));
  const result = await installCodexPolicy(parsed.codexHome);
  options.stdout.write(formatPsList(result));
  return 0;
}

export async function runInstallGlobalCli(options: {
  argv: string[];
  stdout: NodeJS.WritableStream;
}): Promise<number> {
  const parsed = parseArguments(getCommandArgs(options.argv));
  const result = await installShellIntegration({
    BinDir: parsed.binDir,
    ModuleInstallRoot: parsed.moduleRoot,
  });
  options.stdout.write(formatPsList(result));
  return 0;
}
