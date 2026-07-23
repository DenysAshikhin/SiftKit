import { installCodexPolicy, installShellIntegration, installSiftKit } from '../install.js';
import { formatPsList, parseArguments } from './args.js';
import { CLI_COMMAND_CATALOG } from './command-catalog.js';

export async function runInstall(stdout: NodeJS.WritableStream): Promise<number> {
  const result = await installSiftKit(false);
  stdout.write(formatPsList(result));
  return 0;
}

export async function runCodexPolicyCli(options: {
  argv: string[];
  stdout: NodeJS.WritableStream;
}): Promise<number> {
  const parsed = parseArguments(CLI_COMMAND_CATALOG.resolve(options.argv).args);
  const result = await installCodexPolicy(parsed.codexHome);
  options.stdout.write(formatPsList(result));
  return 0;
}

export async function runInstallGlobalCli(options: {
  argv: string[];
  stdout: NodeJS.WritableStream;
}): Promise<number> {
  const parsed = parseArguments(CLI_COMMAND_CATALOG.resolve(options.argv).args);
  const result = await installShellIntegration({
    BinDir: parsed.binDir,
    ModuleInstallRoot: parsed.moduleRoot,
  });
  options.stdout.write(formatPsList(result));
  return 0;
}
