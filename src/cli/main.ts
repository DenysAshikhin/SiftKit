import { runCli } from './dispatch.js';
import { commandReadsStdin, readStdinToEnd } from './stdin-input.js';

async function readStdin(argv: string[]) {
  if (process.stdin.isTTY || !commandReadsStdin(argv)) {
    return { text: '', stdinWaitMs: 0 };
  }
  return readStdinToEnd(process.stdin);
}

async function main(): Promise<void> {
  const processStartedAtMs = Date.now();
  const argv = process.argv.slice(2);
  const stdin = await readStdin(argv);
  process.exitCode = await runCli({
    argv,
    stdinText: stdin.text,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    timing: {
      processStartedAtMs,
      stdinWaitMs: stdin.stdinWaitMs,
    },
  });
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
