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
}

if (require.main === module) {
  const repoRoot = path.resolve(__dirname, '..');
  syncDistRuntime(path.join(repoRoot, 'dist', 'src'), path.join(repoRoot, 'dist'));
}

module.exports = {
  syncDistRuntime,
};
