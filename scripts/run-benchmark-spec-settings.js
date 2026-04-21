const { spawnSync } = require('node:child_process');
const path = require('node:path');

const VALUE_OPTIONS = new Set([
  '-Prompt',
  '-OutputRoot',
  '-StatusHost',
  '-StatusPort',
  '-RepoRoot',
  '-CaseLimit',
]);

function normalizeForwardedArgs(argv) {
  const normalizedArgs = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!VALUE_OPTIONS.has(token)) {
      normalizedArgs.push(token);
      continue;
    }

    const valueParts = [];
    let cursor = index + 1;
    while (cursor < argv.length && !VALUE_OPTIONS.has(argv[cursor])) {
      valueParts.push(argv[cursor]);
      cursor += 1;
    }

    normalizedArgs.push(token);
    if (valueParts.length > 0) {
      normalizedArgs.push(valueParts.join(' '));
    }
    index = cursor - 1;
  }

  return normalizedArgs;
}

function buildPowerShellArgs(repoRoot, forwardedArgv) {
  const scriptPath = path.resolve(repoRoot, 'scripts', 'benchmark-siftkit-spec-settings.ps1');
  return ['-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...normalizeForwardedArgs(forwardedArgv)];
}

function runBuild(repoRoot) {
  const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm run build'], {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  return result.status ?? 1;
}

function main() {
  const repoRoot = process.cwd();
  const buildStatus = runBuild(repoRoot);
  if (buildStatus !== 0) {
    process.exit(buildStatus);
  }
  const result = spawnSync('powershell.exe', buildPowerShellArgs(repoRoot, process.argv.slice(2)), {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status ?? 1);
}

module.exports = {
  VALUE_OPTIONS,
  buildPowerShellArgs,
  main,
  normalizeForwardedArgs,
  runBuild,
};

if (require.main === module) {
  main();
}
