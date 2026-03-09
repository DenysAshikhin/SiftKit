#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const os = require('node:os');
const { dirname, join } = require('node:path');
const fs = require('node:fs');
const { startStatusServer } = require('../siftKitStatus');

const scriptPath = join(__dirname, 'siftkit.ps1');
const isWindows = process.platform === 'win32';
const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
const shellCandidates = isWindows
  ? [
      join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      'powershell.exe',
      'pwsh.exe'
    ]
  : ['pwsh', 'powershell'];
const knownCommands = new Set(['summary', 'run', 'find-files', 'install', 'test', 'eval', 'codex-policy', 'install-global', 'status-server']);
const cliArgs = process.argv.slice(2);
const commandName = getCommandName(cliArgs);
const commandArgs = getCommandArgs(cliArgs);
const isSummaryMode = commandName === 'summary';

// Only summary mode consumes piped stdin; long-running commands like status-server
// must not block on a non-TTY stream that may never close under process managers.
const hasStdin = isSummaryMode && !process.stdin.isTTY;
let stdinText = '';

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

function normalizeInputText(text) {
  if (typeof text !== 'string') {
    return text;
  }

  return text.replace(/[\r\n]+$/u, '');
}

function parseSummaryArgs(args) {
  const commandArgs = getCommandArgs(args);
  const parsed = {
    positionals: []
  };

  for (let i = 0; i < commandArgs.length; i += 1) {
    const token = commandArgs[i];
    switch (token) {
      case '--question':
        parsed.question = commandArgs[++i];
        break;
      case '--text':
        parsed.text = commandArgs[++i];
        break;
      case '--file':
        parsed.file = commandArgs[++i];
        break;
      default:
        parsed.positionals.push(token);
        break;
    }
  }

  return parsed;
}

function sleepMs(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function ensureDirectory(path) {
  fs.mkdirSync(path, { recursive: true });
}

function getRuntimeRoot() {
  const configuredStatusPath = process.env.sift_kit_status;
  if (configuredStatusPath && configuredStatusPath.trim()) {
    const statusDirectory = dirname(configuredStatusPath);
    if (statusDirectory.split(/[\\/]/u).filter(Boolean).at(-1)?.toLowerCase() === 'status') {
      return dirname(statusDirectory);
    }

    return statusDirectory;
  }

  return join(process.env.USERPROFILE || os.homedir(), '.siftkit');
}

function acquireLock(lockPath, timeoutMs) {
  const startedAt = Date.now();
  ensureDirectory(dirname(lockPath));

  while (true) {
    try {
      return fs.openSync(lockPath, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`SiftKit is busy. Timed out after ${timeoutMs} ms waiting for the execution lock.`);
      }

      sleepMs(25);
    }
  }
}

function releaseLock(lockPath, handle) {
  if (handle !== null && handle !== undefined) {
    fs.closeSync(handle);
  }

  fs.rmSync(lockPath, { force: true });
}

function getMockSummary(question) {
  if (question.includes('did tests pass')) {
    return 'test_order_processing failed and test_auth_timeout failed';
  }

  if (question.includes('resources added, changed, and destroyed')) {
    return 'destroy aws_db_instance.main; raw review required';
  }

  const token = process.env.SIFTKIT_TEST_TOKEN;
  return token ? `mock summary ${token}` : 'mock summary';
}

function runMockSummaryFallback(args) {
  const parsed = parseSummaryArgs(args);
  const question = parsed.question || parsed.positionals[0];
  if (!question) {
    throw new Error('A question is required.');
  }

  let inputText = null;
  if (parsed.text) {
    inputText = parsed.text;
  } else if (parsed.file) {
    if (fs.existsSync(parsed.file)) {
      inputText = fs.readFileSync(parsed.file, 'utf8');
    } else if (hasStdin) {
      inputText = stdinText;
    } else {
      throw new Error(`Input file not found: ${parsed.file}`);
    }
  } else if (hasStdin) {
    inputText = stdinText;
  }

  inputText = normalizeInputText(inputText);
  if (!inputText || !inputText.trim()) {
    throw new Error('Provide --text, --file, or pipe input into siftkit.');
  }

  const lineCount = inputText.length === 0 ? 0 : inputText.replace(/\r\n/g, '\n').split('\n').length;
  if (inputText.length < 500 && lineCount < 16) {
    return inputText;
  }

  const runtimeRoot = getRuntimeRoot();
  ensureDirectory(runtimeRoot);
  const lockPath = join(runtimeRoot, 'execution.lock');
  const timeoutMs = Number.parseInt(process.env.SIFTKIT_LOCK_TIMEOUT_MS || '5000', 10);
  const handle = acquireLock(lockPath, Number.isFinite(timeoutMs) ? timeoutMs : 5000);

  try {
    const sleepMsValue = Number.parseInt(process.env.SIFTKIT_TEST_PROVIDER_SLEEP_MS || '0', 10);
    if (Number.isFinite(sleepMsValue) && sleepMsValue > 0) {
      sleepMs(sleepMsValue);
    }

    return getMockSummary(question);
  } finally {
    releaseLock(lockPath, handle);
  }
}

let forwardedArgs = [...cliArgs];

if (commandName === 'status-server') {
  const server = startStatusServer();
  const shutdown = () => {
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} else {
  let lastError = null;
  for (const shell of shellCandidates) {
    const result = spawnSync(
      shell,
      ['-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...forwardedArgs],
      {
        input: hasStdin ? stdinText : undefined,
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

  if (process.env.SIFTKIT_TEST_PROVIDER === 'mock' && isSummaryMode) {
    try {
      process.stdout.write(runMockSummaryFallback(forwardedArgs));
      process.exit(0);
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
  }

  console.error(`Unable to launch PowerShell for SiftKit: ${lastError ? lastError.message : 'unknown error'}`);
  process.exit(1);
}
