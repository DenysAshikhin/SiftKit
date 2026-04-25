#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const distRoot = path.join(repoRoot, 'dist');
const buildStampPath = path.join(distRoot, '.build-test-stamp');
const requiredOutputs = [
  path.join(distRoot, 'config', 'index.js'),
  path.join(distRoot, 'scripts', 'run-tests.js'),
  path.join(distRoot, 'scripts', 'test-targets.js'),
];
const sourceRoots = [
  path.join(repoRoot, 'src'),
  path.join(repoRoot, 'scripts'),
  path.join(repoRoot, 'tsconfig.json'),
  path.join(repoRoot, 'tsconfig.scripts.json'),
];

function getNewestMtimeMs(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return Number.POSITIVE_INFINITY;
  }
  const stats = fs.statSync(targetPath);
  if (!stats.isDirectory()) {
    return stats.mtimeMs;
  }

  let newestMtimeMs = stats.mtimeMs;
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    const entryPath = path.join(targetPath, entry.name);
    newestMtimeMs = Math.max(newestMtimeMs, getNewestMtimeMs(entryPath));
  }
  return newestMtimeMs;
}

function shouldBuild() {
  if (!requiredOutputs.every((targetPath) => fs.existsSync(targetPath))) {
    return true;
  }
  if (!fs.existsSync(buildStampPath)) {
    return true;
  }
  const buildStampMtimeMs = fs.statSync(buildStampPath).mtimeMs;
  const newestSourceMtimeMs = sourceRoots.reduce(
    (currentMax, targetPath) => Math.max(currentMax, getNewestMtimeMs(targetPath)),
    0,
  );
  return newestSourceMtimeMs > buildStampMtimeMs;
}

function runNodeCommand(scriptPath, args) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

function ensureBuildStamp() {
  fs.mkdirSync(path.dirname(buildStampPath), { recursive: true });
  fs.writeFileSync(buildStampPath, `${new Date().toISOString()}\n`, 'utf8');
}

if (!shouldBuild()) {
  process.stdout.write('[build:test] up to date\n');
  process.exit(0);
}

runNodeCommand(path.join(repoRoot, 'node_modules', 'typescript', 'lib', 'tsc.js'), ['-p', path.join(repoRoot, 'tsconfig.json')]);
runNodeCommand(path.join(repoRoot, 'node_modules', 'typescript', 'lib', 'tsc.js'), ['-p', path.join(repoRoot, 'tsconfig.scripts.json')]);
runNodeCommand(path.join(repoRoot, 'scripts', 'sync-dist-runtime.js'), []);
ensureBuildStamp();
