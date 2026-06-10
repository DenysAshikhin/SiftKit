import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

type SourceFile = {
  path: string;
  text: string;
};

const FORBIDDEN_CLI_IMPORTS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'summary engine', pattern: /from\s+['"]\.\.\/summary\/core\.js['"]/u },
  { label: 'summary deterministic helpers', pattern: /from\s+['"]\.\.\/summary\/(?:measure|test-output)\.js['"]/u },
  { label: 'repo-search engine', pattern: /from\s+['"]\.\.\/repo-search\/(?:index|execute)\.js['"]/u },
  { label: 'local command engine', pattern: /from\s+['"]\.\.\/command\.js['"]/u },
  { label: 'local interactive engine', pattern: /from\s+['"]\.\.\/interactive\.js['"]/u },
  { label: 'local eval engine', pattern: /from\s+['"]\.\.\/eval\.js['"]/u },
  { label: 'status-server internals', pattern: /from\s+['"]\.\.\/status-server\//u },
  { label: 'execution lock', pattern: /from\s+['"]\.\.\/execution-lock\.js['"]/u },
];

function listTypeScriptFiles(root: string): SourceFile[] {
  const result: SourceFile[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...listTypeScriptFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts')) {
      result.push({
        path: fullPath.replace(/\\/gu, '/'),
        text: fs.readFileSync(fullPath, 'utf8'),
      });
    }
  }
  return result;
}

test('CLI modules do not import engine or status-server internals', () => {
  const cliFiles = listTypeScriptFiles(path.join(process.cwd(), 'src', 'cli'));
  const violations: string[] = [];

  for (const file of cliFiles) {
    for (const rule of FORBIDDEN_CLI_IMPORTS) {
      if (rule.pattern.test(file.text)) {
        violations.push(`${file.path}: forbidden ${rule.label}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});

test('status server does not dynamically load repo-search engine', () => {
  const statusServerFiles = listTypeScriptFiles(path.join(process.cwd(), 'src', 'status-server'));
  const violations = statusServerFiles
    .filter((file) => /require\.cache|require\.resolve\(['"]\.\.\/repo-search\/index\.js['"]\)|loadRepoSearchExecutor/u.test(file.text))
    .map((file) => file.path);

  assert.deepEqual(violations, []);
});
