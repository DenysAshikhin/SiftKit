#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

function syncDistRuntime(sourceRoot, targetRoot) {
  if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
    throw new Error(`Expected compiled source directory: ${sourceRoot}`);
  }
  fs.mkdirSync(targetRoot, { recursive: true });
  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    const sourcePath = path.join(sourceRoot, entry.name);
    const targetPath = path.join(targetRoot, entry.name);
    fs.cpSync(sourcePath, targetPath, { recursive: true, force: true });
  }
  removeDeletedRuntimeEntrypoints(sourceRoot, targetRoot);
}

function removeDeletedRuntimeEntrypoints(sourceRoot, targetRoot) {
  for (const moduleName of ['command', 'interactive']) {
    if (fs.existsSync(path.join(sourceRoot, `${moduleName}.js`))) {
      continue;
    }
    for (const root of [sourceRoot, targetRoot]) {
      for (const extension of ['.js', '.d.ts', '.js.map', '.d.ts.map']) {
        fs.rmSync(path.join(root, `${moduleName}${extension}`), { force: true });
      }
    }
  }
}

if (require.main === module) {
  const repoRoot = path.resolve(__dirname, '..');
  syncDistRuntime(path.join(repoRoot, 'dist', 'src'), path.join(repoRoot, 'dist'));
}

module.exports = {
  syncDistRuntime,
};
