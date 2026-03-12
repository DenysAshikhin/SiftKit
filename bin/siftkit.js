#!/usr/bin/env node

const fs = require('node:fs');
const { join } = require('node:path');

const runtimePath = join(__dirname, '..', 'dist', 'src', 'cli.js');

if (!fs.existsSync(runtimePath)) {
  console.error(`TS CLI entrypoint not found at ${runtimePath}. Run npm run build.`);
  process.exit(1);
}

const { runCli } = require(runtimePath);

async function readStdin() {
  if (process.stdin.isTTY) {
    return '';
  }

  return await new Promise((resolve, reject) => {
    let collected = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      collected += chunk;
    });
    process.stdin.on('end', () => resolve(collected));
    process.stdin.on('error', reject);
  });
}

void (async () => {
  try {
    const stdinText = await readStdin();
    const exitCode = await runCli({
      argv: process.argv.slice(2),
      stdinText,
      stdout: process.stdout,
      stderr: process.stderr,
    });
    process.exit(exitCode);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
})();
