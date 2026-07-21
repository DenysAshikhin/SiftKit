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
  const distRoot = path.join(repoRoot, 'dist');
  syncDistRuntime(path.join(distRoot, 'src'), distRoot);
  // The src-derived output in dist/** is ES modules (src/package.json is
  // type:module), but tsc writes no package.json into the output dir. Without one
  // Node treats each file as typeless: it prints MODULE_TYPELESS_PACKAGE_JSON to
  // stderr and re-parses every module as ESM on load (a per-invocation perf hit
  // for the spawned CLI/status server). Mark dist as ESM so it loads cleanly.
  fs.writeFileSync(path.join(distRoot, 'package.json'), '{\n  "type": "module"\n}\n', 'utf8');
  // dist/scripts/** is compiled from scripts/ via tsconfig.scripts.json, which
  // has no type:module, so tsc emits CommonJS there. Override the ESM marker for
  // that subtree so run-tests.js and the other CJS dev scripts keep working.
  fs.writeFileSync(path.join(distRoot, 'scripts', 'package.json'), '{\n  "type": "commonjs"\n}\n', 'utf8');
}

module.exports = {
  syncDistRuntime,
};
