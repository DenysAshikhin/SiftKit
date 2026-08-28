#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function writeRuntimePackageMarkers(distRoot: string): void {
  const runtimePackageJson = {
    type: 'module',
  };
  writeFileSync(
    join(distRoot, 'package.json'),
    `${JSON.stringify(runtimePackageJson, null, 2)}\n`,
    'utf8',
  );
}

const CLI_SHEBANG = '#!/usr/bin/env node\n';

/** npm's sh-shim executes dist/cli/main.js directly; without a shebang, sh parses ESM as shell. */
export function ensureCliShebang(distRoot: string): void {
  const mainPath = join(distRoot, 'cli', 'main.js');
  if (!existsSync(mainPath)) {
    throw new Error(`Expected CLI entry point at ${mainPath}; build layout changed.`);
  }
  const content = readFileSync(mainPath, 'utf8');
  if (content.startsWith(CLI_SHEBANG)) {
    return;
  }
  writeFileSync(mainPath, `${CLI_SHEBANG}${content}`, 'utf8');
}

function main(): void {
  const extraArgument = process.argv[2];
  if (extraArgument !== undefined) {
    throw new Error(`sync-dist-runtime no longer accepts arguments; got: ${extraArgument}`);
  }
  const repoRoot = resolve(import.meta.dirname, '..');
  const distRoot = join(repoRoot, 'dist');
  writeRuntimePackageMarkers(distRoot);
  ensureCliShebang(distRoot);
}

const isDirectExecution = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

if (isDirectExecution) {
  main();
}
