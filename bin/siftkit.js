#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const os = require('node:os');
const { join } = require('node:path');
const fs = require('node:fs');

const scriptPath = join(__dirname, 'siftkit.ps1');
const isWindows = process.platform === 'win32';
const shellCandidates = isWindows
  ? ['powershell.exe', 'pwsh.exe']
  : ['pwsh', 'powershell'];
const knownCommands = new Set(['summary', 'run', 'find-files', 'install', 'test', 'eval', 'codex-policy', 'install-global']);
const cliArgs = process.argv.slice(2);

const hasStdin = !process.stdin.isTTY;
let stdinText = '';
let tempInputRoot = null;
let tempInputPath = null;

if (hasStdin) {
  try {
    stdinText = fs.readFileSync(0, 'utf8');
  } catch (error) {
    console.error(`Failed to read stdin: ${error.message}`);
    process.exit(1);
  }
}

function getCommandName(args) {
  if (args.length > 0 && knownCommands.has(args[0])) {
    return args[0];
  }

  return 'summary';
}

function getCommandArgs(args) {
  const commandName = getCommandName(args);
  if (commandName === 'summary' && (args.length === 0 || !knownCommands.has(args[0]))) {
    return args;
  }

  return args.slice(1);
}

function hasExplicitSummaryInput(args) {
  return args.includes('--text') || args.includes('--file');
}

let forwardedArgs = [...cliArgs];
const commandArgs = getCommandArgs(cliArgs);
const isSummaryMode = getCommandName(cliArgs) === 'summary';

if (hasStdin && isSummaryMode && !hasExplicitSummaryInput(commandArgs)) {
  tempInputRoot = fs.mkdtempSync(join(os.tmpdir(), 'siftkit-'));
  tempInputPath = join(tempInputRoot, 'stdin.txt');
  fs.writeFileSync(tempInputPath, stdinText, 'utf8');
  forwardedArgs = [...cliArgs, '--file', tempInputPath];
}

let lastError = null;
try {
  for (const shell of shellCandidates) {
    const result = spawnSync(
      shell,
      ['-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...forwardedArgs],
      {
        input: tempInputPath ? undefined : hasStdin ? stdinText : undefined,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      }
    );

    if (!result.error) {
      if (result.stdout) {
        process.stdout.write(result.stdout);
      }
      if (result.stderr) {
        process.stderr.write(result.stderr);
      }
      process.exit(result.status === null ? 1 : result.status);
    }

    lastError = result.error;
  }
} finally {
  if (tempInputRoot) {
    fs.rmSync(tempInputRoot, { recursive: true, force: true });
  }
}

console.error(`Unable to launch PowerShell for SiftKit: ${lastError ? lastError.message : 'unknown error'}`);
process.exit(1);
