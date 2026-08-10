import { ensureStatusServerReachable } from '../config/index.js';
import {
  validateRepoSearchTokens,
  type CliRunOptions,
} from './args.js';
import { CLI_COMMAND_CATALOG } from './command-catalog.js';
import { showHelp } from './help.js';
import { detectRepoAgentHelpInvocation, showRepoAgentHelp } from './repo-agent-help.js';
import { parseRepoAgentInvocation } from './repo-agent-args.js';
import { runCaptureInternalCli } from './run-capture.js';
import { runCommandCli } from './run-command.js';
import { runConfigGet, runConfigSet } from './run-config.js';
import { runEvalCli } from './run-eval.js';
import { runFindFiles } from './run-find-files.js';
import { runCodexPolicyCli, runInstall, runInstallGlobalCli } from './run-install.js';
import { runInternal } from './run-internal.js';
import { runPresetList } from './run-preset-list.js';
import { runPresetCli } from './run-preset.js';
import { runRepoSearchCli } from './run-repo-search.js';
import { runRepoAgentCli } from './run-repo-agent.js';
import { runSummary } from './run-summary.js';
import { runTest } from './run-test.js';
import { assertStdinIsTty } from './tty.js';
import { readNestedAgentRunId } from '../lib/agent-run-marker.js';
import { runAssistantCli } from './run-assistant.js';

function failUnknownCommand(commandName: never): never {
  throw new Error(`Unhandled CLI command: ${commandName}`);
}

export async function runCli(options: CliRunOptions): Promise<number> {
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;

  const repoAgentHelp = detectRepoAgentHelpInvocation(options.argv);
  if (repoAgentHelp !== null) {
    showRepoAgentHelp({ stdout, invocation: repoAgentHelp });
    return 0;
  }

  if (options.argv.length === 0 || ['help', '--help', '--h', '-h', '-help'].includes(options.argv[0])) {
    showHelp(stdout);
    return 0;
  }

  const invocation = CLI_COMMAND_CATALOG.resolve(options.argv);
  const commandName = invocation.command.name;
  const commandArgs = invocation.args;
  const nestedAgentRunId = readNestedAgentRunId();
  const repoAgentControl = commandName === 'repo-agent'
    && (commandArgs[0] === 'decide' || commandArgs[0] === 'status');
  if (
    nestedAgentRunId
    && invocation.command.modelLock
    && commandName !== 'summary'
    && !repoAgentControl
  ) {
    stderr.write(
      `siftkit ${commandName} is blocked inside agent run ${nestedAgentRunId}: `
      + 'the status server\'s model lock is held by the parent run, so this call would deadlock. '
      + 'Run the underlying command raw instead of routing it through siftkit.\n',
    );
    return 1;
  }
  if (!invocation.command.exposed) {
    const availableCommands = [...CLI_COMMAND_CATALOG.exposedCommandNames, 'help'].join(', ');
    stderr.write(
      `Command '${options.argv[0]}' is not exposed in this CLI build. Available commands: ${availableCommands}.\n`,
    );
    return 1;
  }
  const commandHelpRequested = commandArgs.some((token) => token === '-h' || token === '--h' || token === '--help' || token === '-help');
  try {
    const repoAgentInvocation = commandName === 'repo-agent'
      ? parseRepoAgentInvocation(commandArgs)
      : null;
    if (
      repoAgentInvocation?.kind === 'start'
      && repoAgentInvocation.taskTokenCount > 1
    ) {
      stderr.write(
        `note: joined ${repoAgentInvocation.taskTokenCount} command-line tokens into one task; `
        + 'embedded double quotes were lost to shell argument splitting.\n'
        + `  task: ${repoAgentInvocation.task}\n`,
      );
    }
    if (commandName === 'repo-search') {
      validateRepoSearchTokens(commandArgs);
      // Fail fast before the server preflight so a non-TTY interactive run never
      // touches the network; run-repo-search re-asserts the same invariant.
      if (!commandHelpRequested) {
        assertStdinIsTty(commandArgs.includes('--interactive'), options.stdin, '--interactive');
      }
    }
    if (commandName === 'repo-search' && commandHelpRequested) {
      return await runRepoSearchCli({ args: commandArgs, stdout, stderr, stdin: options.stdin });
    }
    if (commandName === 'run' && commandHelpRequested) {
      showHelp(stdout);
      return 0;
    }
    let serverPreflightMs: number | null = options.timing?.serverPreflightMs ?? null;
    if (invocation.command.serverDependent && !(commandName === 'summary' && nestedAgentRunId)) {
      const serverPreflightStartedAt = Date.now();
      await ensureStatusServerReachable();
      serverPreflightMs = Date.now() - serverPreflightStartedAt;
    }

    switch (commandName) {
      case 'summary':
        return await runSummary({
          args: commandArgs,
          stdinText: options.stdinText,
          stdout,
          stderr,
          nestedAgentRunId,
          timing: {
            processStartedAtMs: options.timing?.processStartedAtMs ?? null,
            stdinWaitMs: options.timing?.stdinWaitMs ?? null,
            serverPreflightMs,
          },
        });
      case 'preset':
        if (commandArgs[0] === 'list') {
          return await runPresetList({ stdout });
        }
        throw new Error('Supported preset command: siftkit preset list');
      case 'assistant':
        return await runAssistantCli({ args: commandArgs, stdout });
      case 'install':
        return await runInstall(stdout);
      case 'config-get':
        return await runConfigGet(stdout);
      case 'config-set':
        return await runConfigSet({ args: commandArgs, stdout });
      case 'run':
        if (commandArgs.includes('--preset')) {
          return await runPresetCli({ args: commandArgs, stdinText: options.stdinText, stdout, stderr });
        }
        return await runCommandCli({ args: commandArgs, stdout, stderr });
      case 'eval':
        return await runEvalCli({ args: commandArgs, stdout, stderr });
      case 'codex-policy':
        return await runCodexPolicyCli({ args: commandArgs, stdout });
      case 'install-global':
        return await runInstallGlobalCli({ args: commandArgs, stdout });
      case 'capture-internal':
        return await runCaptureInternalCli({ args: commandArgs, stdout, stderr });
      case 'repo-search':
        return await runRepoSearchCli({ args: commandArgs, stdout, stderr, stdin: options.stdin });
      case 'repo-agent':
        if (repoAgentInvocation === null) {
          throw new Error('Repo-agent invocation was not parsed.');
        }
        return await runRepoAgentCli({
          invocation: repoAgentInvocation,
          stdout,
          stderr,
          stdin: options.stdin,
        });
      case 'find-files':
        return await runFindFiles({ args: commandArgs, stdout });
      case 'test':
        return await runTest(stdout);
      case 'internal':
        return await runInternal({ args: commandArgs, stdout });
      default:
        return failUnknownCommand(commandName);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${message}\n`);
    return 1;
  }
}
