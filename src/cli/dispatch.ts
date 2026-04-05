import { ensureStatusServerReachable } from '../config.js';
import {
  BLOCKED_PUBLIC_COMMANDS,
  getCommandArgs,
  getCommandName,
  SERVER_DEPENDENT_COMMANDS,
  validateRepoSearchTokens,
  type CliRunOptions,
} from './args.js';
import { showHelp } from './help.js';
import { runCaptureInternalCli } from './run-capture.js';
import { runCommandCli } from './run-command.js';
import { runConfigGet, runConfigSet } from './run-config.js';
import { runEvalCli } from './run-eval.js';
import { runFindFiles } from './run-find-files.js';
import { runCodexPolicyCli, runInstall, runInstallGlobalCli } from './run-install.js';
import { runInternal } from './run-internal.js';
import { runRepoSearchCli } from './run-repo-search.js';
import { runSummary } from './run-summary.js';
import { runTest } from './run-test.js';

export async function runCli(options: CliRunOptions): Promise<number> {
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;

  if (options.argv.length === 0 || ['help', '--help', '--h', '-h', '-help'].includes(options.argv[0])) {
    showHelp(stdout);
    return 0;
  }

  const commandName = getCommandName(options.argv);
  if (BLOCKED_PUBLIC_COMMANDS.has(options.argv[0])) {
    stderr.write(`Command '${options.argv[0]}' is not exposed in this CLI build. Available commands: summary, repo-search, help.\n`);
    return 1;
  }
  const commandArgs = getCommandArgs(options.argv);
  const commandHelpRequested = commandArgs.some((token) => token === '-h' || token === '--h' || token === '--help' || token === '-help');
  try {
    if (commandName === 'repo-search') {
      validateRepoSearchTokens(commandArgs);
    }
    if (commandName === 'repo-search' && commandHelpRequested) {
      return await runRepoSearchCli({ argv: options.argv, stdout });
    }
    if (SERVER_DEPENDENT_COMMANDS.has(commandName)) {
      await ensureStatusServerReachable();
    }

    switch (commandName) {
      case 'summary':
        return await runSummary({ argv: options.argv, stdinText: options.stdinText, stdout });
      case 'install':
        return await runInstall(stdout);
      case 'config-get':
        return await runConfigGet(stdout);
      case 'config-set':
        return await runConfigSet({ argv: options.argv, stdout });
      case 'run':
        return await runCommandCli({ argv: options.argv, stdout });
      case 'eval':
        return await runEvalCli({ argv: options.argv, stdout });
      case 'codex-policy':
        return await runCodexPolicyCli({ argv: options.argv, stdout });
      case 'install-global':
        return await runInstallGlobalCli({ argv: options.argv, stdout });
      case 'capture-internal':
        return await runCaptureInternalCli({ argv: options.argv, stdout });
      case 'repo-search':
        return await runRepoSearchCli({ argv: options.argv, stdout });
      case 'find-files':
        return await runFindFiles({ argv: options.argv, stdout });
      case 'test':
        return await runTest(stdout);
      case 'internal':
        return await runInternal({ argv: options.argv, stdout });
      default:
        return 127;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${message}\n`);
    return 1;
  }
}
