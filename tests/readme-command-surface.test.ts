import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { CLI_COMMAND_CATALOG } from '../src/cli/command-catalog.ts';
import { readPackageJson } from './helpers/package-json.ts';

const repoRoot = process.cwd();

// The required whitespace keeps backtick-quoted prose and file names out of the match.
const SIFTKIT_COMMAND_PATTERN = /siftkit\s+([a-z][a-z0-9-]*)/gu;
const NPM_RUN_SCRIPT_PATTERN = /npm run ([a-z][a-z0-9:.-]*)/gu;

const DOC_FILES = ['README.md', 'eval/llama-spec-prompt.txt'] as const;

function readDoc(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function findTokens(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[1]);
}

test('every documented siftkit command is exposed by the CLI', () => {
  const exposedCommands = new Set<string>(CLI_COMMAND_CATALOG.exposedCommandNames);
  for (const file of DOC_FILES) {
    const undocumented = findTokens(readDoc(file), SIFTKIT_COMMAND_PATTERN).filter(
      (command) => command !== 'help' && !exposedCommands.has(command),
    );
    assert.deepEqual(undocumented, [], `${file} names non-exposed commands: ${undocumented.join(', ')}`);
  }
});

test('the README documents the full exposed surface and the verified install paths', () => {
  const readme = readDoc('README.md');
  const documentedCommands = new Set<string>(findTokens(readme, SIFTKIT_COMMAND_PATTERN));
  const missing = CLI_COMMAND_CATALOG.exposedCommandNames.filter((command) => !documentedCommands.has(command));
  assert.deepEqual(missing, [], `README omits exposed commands: ${missing.join(', ')}`);
  assert.match(readme, /Install-SiftKitShellIntegration/u);
  assert.match(readme, /npm run refresh-global/u);
});

test('every documented npm run script exists in package.json', () => {
  const scripts = readPackageJson().scripts;
  for (const file of DOC_FILES) {
    const missingScripts = findTokens(readDoc(file), NPM_RUN_SCRIPT_PATTERN).filter(
      (script) => !Object.hasOwn(scripts, script),
    );
    assert.deepEqual(missingScripts, [], `${file} names missing package.json scripts: ${missingScripts.join(', ')}`);
  }
});