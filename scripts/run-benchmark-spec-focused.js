const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { normalizeForwardedArgs, runBuild } = require('./run-benchmark-spec-settings.js');

function buildFocusedPowerShellArgs(repoRoot, forwardedArgv) {
  const scriptPath = path.resolve(repoRoot, 'scripts', 'benchmark-siftkit-spec-settings.ps1');
  return [
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    '-CaseSet',
    'Focused10',
    ...normalizeForwardedArgs(forwardedArgv),
  ];
}

function main() {
  const repoRoot = process.cwd();
  const buildStatus = runBuild(repoRoot);
  if (buildStatus !== 0) {
    process.exit(buildStatus);
  }

  const result = spawnSync('powershell.exe', buildFocusedPowerShellArgs(repoRoot, process.argv.slice(2)), {
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
  buildFocusedPowerShellArgs,
  main,
};

if (require.main === module) {
  main();
}
