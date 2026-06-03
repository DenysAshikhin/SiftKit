#!/usr/bin/env node

const fs = require('node:fs');
const { join } = require('node:path');

const runtimePath = join(__dirname, '..', 'dist', 'cli', 'dispatch.js');

if (!fs.existsSync(runtimePath)) {
  console.error(`TS CLI entrypoint not found at ${runtimePath}. Run npm run build.`);
  process.exit(1);
}

const { runCli } = require(runtimePath);
const { commandReadsStdin, readStdinToEnd } = require(join(__dirname, '..', 'dist', 'cli', 'stdin-input.js'));

// Read stdin only when the resolved command actually consumes it (e.g. piped
// `summary` input). Commands like `repo-search` ignore stdin, so reading it
// would block forever when a caller leaves an open, idle stdin pipe — the usual
// shape when an agent spawns `siftkit` non-interactively.
async function readStdin(argv) {
  if (process.stdin.isTTY || !commandReadsStdin(argv)) {
    return { text: '', stdinWaitMs: 0 };
  }
  return await readStdinToEnd(process.stdin);
}

void (async () => {
  try {
    const processStartedAtMs = Date.now();
    const stdin = await readStdin(process.argv.slice(2));
    const exitCode = await runCli({
      argv: process.argv.slice(2),
      stdinText: stdin.text,
      stdout: process.stdout,
      stderr: process.stderr,
      timing: {
        processStartedAtMs,
        stdinWaitMs: stdin.stdinWaitMs,
      },
    });
    process.exit(exitCode);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
})();
