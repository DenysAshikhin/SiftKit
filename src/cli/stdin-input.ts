import type { Readable } from 'node:stream';
import { getCommandArgs, getCommandName, parseArguments } from './args.js';

// Only these command handlers consume `stdinText`. Every other command ignores
// stdin entirely, so reading it would do nothing useful and risks blocking
// forever when the caller leaves an open, idle stdin pipe (the common case when
// an agent spawns `siftkit` non-interactively). Reading lazily — only when the
// resolved command will actually use the bytes — removes that hang.
const STDIN_CONSUMING_COMMANDS = new Set(['summary', 'run', 'internal']);

// Mirrors the help short-circuit in `runCli`: these never resolve to a command.
const HELP_TOKENS = new Set(['help', '--help', '--h', '-h', '-help']);

export type StdinReadResult = { text: string; stdinWaitMs: number };

/**
 * Decides whether the entrypoint should read stdin for the given argv. Inline
 * input (`--text`/`--file`/`--request-file`) always supersedes stdin, so we
 * never block waiting for a pipe we would not read. `run` only consumes stdin
 * via the `--preset` path; the raw `run <command>` form does not.
 */
export function commandReadsStdin(argv: string[]): boolean {
  if (argv.length === 0 || HELP_TOKENS.has(argv[0])) {
    return false;
  }
  const commandName = getCommandName(argv);
  if (!STDIN_CONSUMING_COMMANDS.has(commandName)) {
    return false;
  }
  const parsed = parseArguments(getCommandArgs(argv));
  if (parsed.text || parsed.file || parsed.requestFile) {
    return false;
  }
  if (commandName === 'run') {
    return Boolean(parsed.preset);
  }
  return true;
}

/** Reads a readable stream to EOF as UTF-8 text. */
export function readStdinToEnd(stream: Readable): Promise<StdinReadResult> {
  const startedAt = Date.now();
  return new Promise<StdinReadResult>((resolve, reject) => {
    let collected = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      collected += chunk;
    });
    stream.on('end', () => resolve({ text: collected, stdinWaitMs: Date.now() - startedAt }));
    stream.on('error', reject);
  });
}
