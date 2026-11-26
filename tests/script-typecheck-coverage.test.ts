import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';
import { readPackageJson } from './helpers/package-json.ts';

const repoRoot = process.cwd();

const TsconfigScriptsSchema = z.object({
  include: z.array(z.string()),
});

function readTsconfigScripts(): z.infer<typeof TsconfigScriptsSchema> {
  const raw = fs.readFileSync(path.join(repoRoot, 'tsconfig.scripts.json'), 'utf8');
  return TsconfigScriptsSchema.parse(JSON.parse(raw));
}

function listTopLevelScripts(): string[] {
  return fs
    .readdirSync(path.join(repoRoot, 'scripts'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => `scripts/${name}`)
    .sort((left, right) => left.localeCompare(right));
}

test('every top-level scripts/*.ts file is covered by tsconfig.scripts.json include', () => {
  const include = readTsconfigScripts().include;
  const uncovered = listTopLevelScripts().filter(
    (script) => !include.some((entry) => path.posix.matchesGlob(script, entry)),
  );
  assert.deepEqual(uncovered, [], `Top-level scripts not typechecked: ${uncovered.join(', ')}`);
});

test('every node-run scripts/ entry point in package.json is covered by tsconfig.scripts.json include', () => {
  const scripts = readPackageJson().scripts;
  const include = readTsconfigScripts().include;
  const entryPoints = Object.values(scripts)
    .flatMap((command) =>
      [...command.matchAll(/node\s+\.\\scripts\\([\w.-]+\.ts)/gu)].map((match) => `scripts/${match[1]}`),
    )
    .sort((left, right) => left.localeCompare(right));
  assert.ok(entryPoints.length > 0, 'expected package.json to run scripts/ entry points through node');
  const uncovered = entryPoints.filter((entry) => !include.some((e) => path.posix.matchesGlob(entry, e)));
  assert.deepEqual(uncovered, [], `package.json entry points not typechecked: ${uncovered.join(', ')}`);
});

test('every literal tsconfig.scripts.json include entry names an existing file', () => {
  const include = readTsconfigScripts().include;
  const missing = include.filter(
    (entry) => !entry.includes('*') && !fs.existsSync(path.join(repoRoot, ...entry.split('/'))),
  );
  assert.deepEqual(missing, [], `Include entries naming missing files: ${missing.join(', ')}`);
});