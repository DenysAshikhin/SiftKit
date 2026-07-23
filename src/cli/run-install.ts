import { installCodexPolicy, installShellIntegration, installSiftKit } from '../install.js';
import { formatPsList, parseArguments, type ResolvedCliArgs } from './args.js';

export async function runInstall(stdout: NodeJS.WritableStream): Promise<number> {
  const result = await installSiftKit(false);
  stdout.write(formatPsList(result));
  return 0;
}

export async function runCodexPolicyCli(options: ResolvedCliArgs & {
  stdout: NodeJS.WritableStream;
}): Promise<number> {
  const parsed = parseArguments(options.args);
  const result = await installCodexPolicy(parsed.codexHome);
  options.stdout.write(formatPsList(result));
  return 0;
}

export async function runInstallGlobalCli(options: ResolvedCliArgs & {
  stdout: NodeJS.WritableStream;
}): Promise<number> {
  const parsed = parseArguments(options.args);
  const result = await installShellIntegration({
    BinDir: parsed.binDir,
    ModuleInstallRoot: parsed.moduleRoot,
  });
  options.stdout.write(formatPsList(result));
  return 0;
}
