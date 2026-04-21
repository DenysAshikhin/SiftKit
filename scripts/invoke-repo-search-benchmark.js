const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function readArgValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index < 0 || index + 1 >= argv.length) {
    return '';
  }
  return String(argv[index + 1] || '');
}

function main() {
  const prompt = readArgValue(process.argv, '--prompt');
  const stdoutPath = readArgValue(process.argv, '--stdout-path');
  const stderrPath = readArgValue(process.argv, '--stderr-path');
  const repoRoot = readArgValue(process.argv, '--repo-root') || process.cwd();
  const cliPath = path.resolve(repoRoot, 'bin', 'siftkit.js');
  const startedAt = new Date();

  const result = spawnSync(process.execPath, [cliPath, 'repo-search', '--prompt', prompt], {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });

  const endedAt = new Date();
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderrParts = [];
  if (typeof result.stderr === 'string' && result.stderr.length > 0) {
    stderrParts.push(result.stderr);
  }
  if (result.error) {
    stderrParts.push(String(result.error.stack || result.error.message || result.error));
  }
  const stderr = stderrParts.join('\n');

  if (stdoutPath) {
    fs.writeFileSync(stdoutPath, stdout, 'utf8');
  }
  if (stderrPath) {
    fs.writeFileSync(stderrPath, stderr, 'utf8');
  }

  process.stdout.write(JSON.stringify({
    command: `siftkit repo-search --prompt "${prompt}"`,
    exitCode: typeof result.status === 'number' ? result.status : 1,
    startedAtUtc: startedAt.toISOString(),
    endedAtUtc: endedAt.toISOString(),
    stdoutPath,
    stderrPath,
  }));
}

main();
