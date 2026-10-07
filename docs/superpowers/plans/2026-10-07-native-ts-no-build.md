# Native TypeScript (No Build) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every step that compiles or bundles TypeScript for Node; Node 26.7 runs `src/`, `scripts/`, `bench/`, `tests/` and `packages/contracts/src` directly.

**Architecture:** Make every source file "erasable" (explicit `.ts`/`.tsx` relative specifiers, no parameter properties, `import type` for types, root `"type": "module"`), switch all tsconfigs to `noEmit`, point every entrypoint at `src/**/*.ts`, run node:test directly on `.ts`, move JSX-reaching tests to Vitest, and install the global CLI as an `npm i -g <repo>` symlink (Node refuses to strip types under `node_modules`, but resolves the symlink's realpath). The dashboard keeps its Vite browser build.

**Tech Stack:** Node 26.7 type stripping, TypeScript 5.9 (`noEmit`, `allowImportingTsExtensions`, `erasableSyntaxOnly`, `verbatimModuleSyntax`), node:test, Vitest 4 (dashboard), Vite 7.

**Verified facts (2026-10-07, Node v26.7.0):**
- `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` for `.ts` under `node_modules`.
- `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` for parameter properties; `--experimental-transform-types` does not exist.
- `--watch-kill-signal` exists.
- ~6.5k relative `.js` specifiers; 413 `TS1294` (parameter-property) errors under `erasableSyntaxOnly`; 0 `verbatimModuleSyntax` errors under Bundler resolution.
- Only 6 root tests reach `.tsx`: `dashboard-app-refresh`, `dashboard-benchmark-controller`, `dashboard-model-presets-section`, `dashboard-presets-section`, `dashboard-runs-controller-e2e`, `dashboard-settings-controller`.

**Rules for the executor:** No commits (user rule). Scratch files live only in `.scratch/native-ts/` (gitignored); delete it in Task 10. Do not touch historical docs (`docs/handoff-*`, `docs/plan-*`, `docs/superpowers/**`, `docs/analysis/**`). Preserve unrelated working-tree changes (`package.json` `exl3:build-wheel` edit, `docs/exl3-backend-setup.md`, untracked docs). Between Task 1 and Task 6 `npm test` is intentionally unavailable; each of those tasks is gated on `npm run typecheck` plus the stated runtime smoke.

---

### Task 0: Baseline

**Files:** Create `.scratch/native-ts/baseline.md`

- [ ] **Step 1: Record current results and timings**

Run each and record pass/fail/test counts and wall time (`Measure-Command`) into `.scratch/native-ts/baseline.md`:
```
npm run typecheck
npm test
npm run test:dashboard
npm run test:process
node .\dist\test-runner\run-tests.js tests\dashboard-app-refresh.test.ts tests\dashboard-benchmark-controller.test.ts tests\dashboard-model-presets-section.test.ts tests\dashboard-presets-section.test.ts tests\dashboard-runs-controller-e2e.test.ts tests\dashboard-settings-controller.test.ts
```
The last command's test count plus `test:dashboard`'s count is the Vitest parity target for Task 7. Any pre-existing failure is recorded here and is not this plan's to fix.

---

### Task 1: Explicit relative specifiers + no-emit tsconfigs + contracts from source

**Files:**
- Create: `tests/relative-import-specifiers.test.ts`, `.scratch/native-ts/rewrite-specifiers.ts`
- Modify: `tsconfig.json`, `tsconfig.scripts.json`, `tsconfig.test.json`, `packages/contracts/tsconfig.json`, `packages/contracts/package.json`, `dashboard/tsconfig.json`, `dashboard/tsconfig.test.json`, `package.json` (`typecheck` script), every `.ts`/`.tsx` under `src tests bench scripts packages/contracts/src dashboard/src dashboard/tests`
- Delete: `tsconfig.test-build.json`, `packages/contracts/tsconfig.tsbuildinfo` (untracked artifact)

- [ ] **Step 1: Write the failing guard test** — `tests/relative-import-specifiers.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const SOURCE_ROOTS = ['src', 'tests', 'bench', 'scripts', path.join('packages', 'contracts', 'src'), path.join('dashboard', 'src'), path.join('dashboard', 'tests')];

function listSourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name.startsWith('.') ? [] : listSourceFiles(entryPath);
    return /\.(?:ts|tsx|mts)$/u.test(entry.name) && !entry.name.endsWith('.d.ts') ? [entryPath] : [];
  });
}

function relativeSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const literal = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
      : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0]
        : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) ? node.argument.literal
          : undefined;
    if (literal !== undefined && ts.isStringLiteral(literal) && /^\.{1,2}\//u.test(literal.text)) {
      found.push(literal.text.split('?')[0] ?? '');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

test('every relative import names an existing file, so Node runs the sources without a build', () => {
  const unresolved = SOURCE_ROOTS.flatMap(listSourceFiles).flatMap((file) => relativeSpecifiers(file)
    .filter((specifier) => !fs.statSync(path.resolve(path.dirname(file), specifier), { throwIfNoEntry: false })?.isFile())
    .map((specifier) => `${file}: ${specifier}`));
  assert.deepEqual(unresolved, []);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/relative-import-specifiers.test.ts`
Expected: FAIL, thousands of `...: ./x.js` entries. (Runs natively already: the file has no relative imports.)

- [ ] **Step 3: Write the codemod** — `.scratch/native-ts/rewrite-specifiers.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const SOURCE_ROOTS = ['src', 'tests', 'bench', 'scripts', path.join('packages', 'contracts', 'src'), path.join('dashboard', 'src'), path.join('dashboard', 'tests')];

function listSourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name.startsWith('.') ? [] : listSourceFiles(entryPath);
    return /\.(?:ts|tsx|mts)$/u.test(entry.name) && !entry.name.endsWith('.d.ts') ? [entryPath] : [];
  });
}

function isFile(candidate: string): boolean {
  return fs.statSync(candidate, { throwIfNoEntry: false })?.isFile() ?? false;
}

/** The specifier rewritten to name an existing file, or null when nothing matches. */
function resolveSpecifier(file: string, specifier: string): string | null {
  const [bare = '', query] = specifier.split('?');
  const absolute = path.resolve(path.dirname(file), bare);
  if (isFile(absolute)) return specifier;
  const stem = bare.replace(/\.js$/u, '');
  for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
    if (isFile(path.resolve(path.dirname(file), stem + suffix))) return stem + suffix + (query === undefined ? '' : `?${query}`);
  }
  return null;
}

const unresolved: string[] = [];
let rewritten = 0;
for (const file of SOURCE_ROOTS.flatMap(listSourceFiles)) {
  const text = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const edits: { start: number; end: number; text: string }[] = [];
  const visit = (node: ts.Node): void => {
    const literal = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
      : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0]
        : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) ? node.argument.literal
          : undefined;
    if (literal !== undefined && ts.isStringLiteral(literal) && /^\.{1,2}\//u.test(literal.text)) {
      const next = resolveSpecifier(file, literal.text);
      if (next === null) unresolved.push(`${file}: ${literal.text}`);
      else if (next !== literal.text) edits.push({ start: literal.getStart(source) + 1, end: literal.getEnd() - 1, text: next });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (edits.length === 0) continue;
  let output = text;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  }
  fs.writeFileSync(file, output, 'utf8');
  rewritten += edits.length;
}
process.stdout.write(`rewrote ${rewritten} specifiers\n`);
if (unresolved.length > 0) {
  process.stderr.write(`${unresolved.join('\n')}\n`);
  process.exitCode = 1;
}
```

- [ ] **Step 4: Run the codemod**

Run: `node .scratch/native-ts/rewrite-specifiers.ts`
Expected: `rewrote ~6500+ specifiers`, exit 0. If any are unresolved, fix each by hand (they are genuinely broken imports). Run it a second time: expected `rewrote 0 specifiers`.

- [ ] **Step 5: Switch tsconfigs to no-emit with `.ts` imports**

`tsconfig.json` → replace the whole file:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "incremental": true,
    "tsBuildInfoFile": ".tscache/main.tsbuildinfo",
    "types": [
      "node"
    ]
  },
  "include": [
    "src/**/*.ts"
  ]
}
```
(`rootDir`, `outDir`, `declaration`, `references` removed: nothing is emitted and `@siftkit/contracts` now resolves to source outside `src`.)

`tsconfig.scripts.json`: delete the `"rewriteRelativeImportExtensions": true` line.

`tsconfig.test.json`: no change needed beyond inheritance (it already sets `noEmit`).

`packages/contracts/tsconfig.json` → replace:
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "noEmit": true, "allowImportingTsExtensions": true, "strict": true,
    "noUncheckedIndexedAccess": true, "verbatimModuleSyntax": true, "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

`packages/contracts/package.json` → replace:
```json
{
  "name": "@siftkit/contracts",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "zod": "^4.4.3" }
}
```

`dashboard/tsconfig.json`: add `"allowImportingTsExtensions": true,` after `"noEmit": true,`; delete the `"paths"` block (its only entry, `@siftkit/contracts`, now resolves through the package `exports`).

`dashboard/tsconfig.test.json`: delete the `"@siftkit/contracts": [...]` entry from `paths` (keep the react entries).

Root `package.json` `typecheck`: replace `tsc -b .\\packages\\contracts\\tsconfig.json` with `tsc -p .\\packages\\contracts\\tsconfig.json`.

Delete `tsconfig.test-build.json` and `packages/contracts/tsconfig.tsbuildinfo`.

- [ ] **Step 6: Verify**

Run: `node --test tests/relative-import-specifiers.test.ts` → PASS.
Run: `npm run typecheck 2>&1 | Select-Object -Last 40` → exit 0. Fix any errors caused by the rewrite (e.g. a type-only `import('./x.ts')` reference) by hand.

---

### Task 2: Remove parameter properties; enforce `erasableSyntaxOnly`

**Files:**
- Create: `.scratch/native-ts/rewrite-parameter-properties.ts`
- Modify: `tsconfig.json`, `packages/contracts/tsconfig.json`, `dashboard/tsconfig.json`, ~121 root files + dashboard/src files with parameter properties

- [ ] **Step 1: Turn on the failing gate**

Add `"erasableSyntaxOnly": true,` to `compilerOptions` in `tsconfig.json`, `packages/contracts/tsconfig.json` and `dashboard/tsconfig.json`.
Run: `npx tsc -p tsconfig.test.json --noEmit --incremental false 2>&1 | Select-String TS1294 | Measure-Object`
Expected: ~413 errors.

- [ ] **Step 2: Write the codemod** — `.scratch/native-ts/rewrite-parameter-properties.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const SOURCE_ROOTS = ['src', 'tests', 'bench', 'scripts', path.join('packages', 'contracts', 'src'), path.join('dashboard', 'src'), path.join('dashboard', 'tests')];
const PROPERTY_MODIFIERS = new Set([ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword, ts.SyntaxKind.ReadonlyKeyword, ts.SyntaxKind.OverrideKeyword]);

function listSourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name.startsWith('.') ? [] : listSourceFiles(entryPath);
    return /\.(?:ts|tsx|mts)$/u.test(entry.name) && !entry.name.endsWith('.d.ts') ? [entryPath] : [];
  });
}

function lineStartOf(text: string, position: number): number {
  return text.lastIndexOf('\n', position - 1) + 1;
}

const failures: string[] = [];
let converted = 0;
for (const file of SOURCE_ROOTS.flatMap(listSourceFiles)) {
  const text = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const edits: { start: number; end: number; text: string }[] = [];
  const where = (node: ts.Node): string => `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
  const visit = (node: ts.Node): void => {
    if (ts.isConstructorDeclaration(node) && node.body !== undefined && ts.isClassLike(node.parent)) {
      const properties = node.parameters.filter((parameter) => (ts.getModifiers(parameter) ?? []).some((modifier) => PROPERTY_MODIFIERS.has(modifier.kind)));
      if (properties.length > 0) {
        const constructorStart = lineStartOf(text, node.getStart(source, true));
        const indent = text.slice(constructorStart, node.getStart(source, true)).match(/^\s*/u)?.[0] ?? '';
        const fields: string[] = [];
        const assignments: string[] = [];
        for (const parameter of properties) {
          if (!ts.isIdentifier(parameter.name) || parameter.type === undefined) {
            failures.push(`${where(parameter)}: parameter property needs an identifier name and a type annotation`);
            continue;
          }
          const name = parameter.name.text;
          const modifiers = (ts.getModifiers(parameter) ?? []).filter((modifier) => PROPERTY_MODIFIERS.has(modifier.kind));
          fields.push(`${indent}${modifiers.map((modifier) => modifier.getText(source)).join(' ')} ${name}${parameter.questionToken ? '?' : ''}: ${parameter.type.getText(source)};`);
          assignments.push(`${indent}  this.${name} = ${name};`);
          const firstModifier = modifiers[0];
          if (firstModifier !== undefined) edits.push({ start: firstModifier.getStart(source), end: parameter.name.getStart(source), text: '' });
          // Field initializers run before the constructor body, so one reading this property would now see undefined.
          for (const member of node.parent.members) {
            if (ts.isPropertyDeclaration(member) && member.initializer !== undefined && new RegExp(`\\bthis\\.${name}\\b`, 'u').test(member.initializer.getText(source))) {
              failures.push(`${where(member)}: initializer reads this.${name}; move it into the constructor by hand`);
            }
          }
        }
        edits.push({ start: constructorStart, end: constructorStart, text: `${fields.join('\n')}\n\n` });
        const superCall = node.body.statements.find((statement) => ts.isExpressionStatement(statement)
          && ts.isCallExpression(statement.expression) && statement.expression.expression.kind === ts.SyntaxKind.SuperKeyword);
        if (node.body.statements.length === 0) {
          edits.push({ start: node.body.getStart(source), end: node.body.getEnd(), text: `{\n${assignments.join('\n')}\n${indent}}` });
        } else {
          const anchor = superCall === undefined ? node.body.getStart(source) + 1 : superCall.getEnd();
          edits.push({ start: anchor, end: anchor, text: `\n${assignments.join('\n')}` });
        }
        converted += properties.length;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (edits.length === 0) continue;
  let output = text;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  }
  fs.writeFileSync(file, output, 'utf8');
}
process.stdout.write(`converted ${converted} parameter properties\n`);
if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exitCode = 1;
}
```

- [ ] **Step 3: Run it**

Run: `node .scratch/native-ts/rewrite-parameter-properties.ts`
Expected: `converted N parameter properties`. For each reported failure, convert that class by hand: declare the field, assign it first thing in the constructor (after `super(...)`), and move any field initializer that reads it into the constructor after that assignment.

- [ ] **Step 4: Verify**

Run: `npx tsc -p tsconfig.test.json --noEmit --incremental false 2>&1 | Select-String TS1294 | Measure-Object` → 0.
Run: `npm run typecheck 2>&1 | Select-Object -Last 40` → exit 0. If lint flags formatting of inserted fields, run `npm run lint:fix` and re-check.

---

### Task 3: Root ESM + `verbatimModuleSyntax`

**Files:**
- Modify: `package.json`, `tsconfig.json`, `dashboard/tsconfig.json`, any file `tsc` flags
- Delete: `src/package.json`, `scripts/package.json`, `bench/package.json` (each only `{"type":"module"}`, now inherited)

- [ ] **Step 1: Make the root package ESM**

Add `"type": "module",` after `"description"` in root `package.json`. Delete the three nested package.json files.
Check for files this flips from CJS to ESM: `git ls-files '*.js'` → only `desktop/ui/popup.js` (browser script, unaffected). `.cjs`/`.mjs` files are explicit and unaffected.

- [ ] **Step 2: Turn on `verbatimModuleSyntax`**

Add `"verbatimModuleSyntax": true,` to `tsconfig.json` and `dashboard/tsconfig.json` `compilerOptions`.
Run: `npm run typecheck 2>&1 | Select-String "TS1484|TS1485|TS1205|TS1286|TS1287" `
Fix each: type-only imports become `import type { X }` / `import { type X }`; type-only re-exports become `export type { X }`.

- [ ] **Step 3: Runtime smoke**

Run: `node .\src\cli\main.ts --help` → exit 0, help text printed.
Run: `node --test tests\relative-import-specifiers.test.ts tests\test-targets.test.ts` → the first passes; the second fails only because `.test-build` is gone/stale (expected until Task 6) — it must NOT fail with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, `ERR_MODULE_NOT_FOUND` or `does not provide an export named`.
Run: `npm run typecheck` → exit 0.

---

### Task 4: Entrypoints and runtime paths point at source

**Files:**
- Create: `tests/cli-shebang.test.ts`
- Delete: `scripts/sync-dist-runtime.ts`, `tests/sync-dist-runtime-shebang.test.ts`
- Modify: `src/cli/main.ts`, `package.json` (`bin`), `bin/siftkit.cmd`, `bin/siftkit.ps1:27-29`, `SiftKit/SiftKit.psm1:18-20`, `desktop/src-tauri/src/main.rs:210`, `src/install.ts:166-182`, `src/status-server/inference-run-flush-queue.ts:42`, `src/lib/paths.ts:9-11`, `src/summary.ts:1`, `scripts/invoke-repo-search-benchmark.cjs:18`, `scripts/verify-client.ps1:61`, `scripts/benchmark-repetition-guard.ts:126-134`, `tsconfig.scripts.json`, `eslint.config.mjs:48-52,97-111`, `.gitignore`

- [ ] **Step 1: Failing test** — `tests/cli-shebang.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('the CLI source carries a node shebang, because npm\'s sh shim executes it directly', () => {
  assert.equal(fs.readFileSync(path.resolve('src', 'cli', 'main.ts'), 'utf8').startsWith('#!/usr/bin/env node\n'), true);
});
```
Run: `node --test tests/cli-shebang.test.ts` → FAIL.

- [ ] **Step 2: Implement**

- `src/cli/main.ts`: insert `#!/usr/bin/env node` as line 1.
- Delete `scripts/sync-dist-runtime.ts` and `tests/sync-dist-runtime-shebang.test.ts`; remove `"scripts/sync-dist-runtime.ts",` and `"scripts/build-test.ts",` from `tsconfig.scripts.json` `include`.
- `package.json`: `"bin": { "siftkit": "src/cli/main.ts" }`.
- `bin/siftkit.cmd` last line: `node "%~dp0..\src\cli\main.ts" %*`
- `bin/siftkit.ps1` `Get-SiftCliPath`: `-ChildPath 'src\cli\main.ts'` and message `'CLI entrypoint not found: {0}.'`.
- `SiftKit/SiftKit.psm1` `Get-SiftCliPath`: `-RelativePath 'src\cli\main.ts'`, message `'CLI entrypoint not found: {0}.'`.
- `src/install.ts`: delete `distSource`, `distTarget` and the `if (existsSync(distSource)) { copyDirectoryContents(distSource, distTarget); }` block; drop `existsSync` from the import only if now unused. Update `tests/install.test.ts:78` comment and any assertion about a copied `dist`.
- `desktop/src-tauri/src/main.rs:210`: default daemon args `vec!["src/status-server/main.ts".to_string()]`; verify with `npm run desktop:test`.
- `src/status-server/inference-run-flush-queue.ts:42`: `return join(packageRoot, 'src', 'status-server', 'inference-run-flush-worker.ts');`
- `src/lib/paths.ts:9-11` comment: `ESM-safe replacement for the CommonJS \`__filename\`; src/** runs as ES modules, where \`__filename\`/\`__dirname\` do not exist.`
- `src/summary.ts:1`: `// Summary module barrel preserves the summary.ts public surface.`
- `scripts/invoke-repo-search-benchmark.cjs:18`: `path.resolve(repoRoot, 'src', 'cli', 'main.ts')`.
- `scripts/verify-client.ps1:61`: `& node .\src\cli\main.ts summary ...` (rest unchanged).
- `scripts/benchmark-repetition-guard.ts`: delete `guardModulePath` and the `'dist' | 'src'` loop; import the src module once via `'../src/repo-search/repetition-guard.ts'`.
- `eslint.config.mjs`: drop `'dist/**'` and `'.test-build/**'` ignores (keep `'dashboard/dist/**'`); rewrite the comment at 97-101 to `// src/** runs as native ESM (root package.json is type:module). CommonJS globals are undefined there; ban them so reintroduction fails loud.` and replace "in the ESM dist" with "in ESM" in the five messages.
- `.gitignore`: delete `/dist`, `packages/contracts/dist`, `*.tgz`, the `# Build output lives in dist/...` comment with its three `src/**` lines, and `/.test-build`.

- [ ] **Step 3: Verify**

Run: `node --test tests/cli-shebang.test.ts tests/relative-import-specifiers.test.ts` → PASS.
Run: `.\bin\siftkit.cmd --help` → exit 0.
Run: `npm run typecheck` → exit 0.

---

### Task 5: Scripts and dependencies without tsx / nodemon / esbuild / build

**Files:**
- Delete: `tests/package-files.test.ts`
- Modify: `package.json`, `scripts/build-clean.ts`, `scripts/analysis/coverage-isolation-runner.ts:25-32`, `scripts/delete-logs.ts:5-7`, `scripts/profile-tool-loop-overhead.ts:16`, `scripts/start-dev.ts:140`, `tests/start-dev-ports.test.ts:93`

- [ ] **Step 1: Update the asserting test first**

`tests/start-dev-ports.test.ts:93` → `assert.equal(packageJson.scripts?.['start:status:stable:server'], 'node .\\src\\status-server\\main.ts');`
Run: `node --test tests/start-dev-ports.test.ts` → FAIL on that assertion.

- [ ] **Step 2: Rewrite `package.json` scripts** (only the lines below change; keep every other script, including the user's `exl3:build-wheel` edit, but with `tsx` → `node`):

```json
"start": "node .\\scripts\\start-dev.ts",
"start:status": "node --watch --watch-kill-signal SIGINT .\\src\\status-server\\main.ts",
"start:status:stable": "node .\\scripts\\start-dev.ts --stable",
"start:status:stable:server": "node .\\src\\status-server\\main.ts",
"build": "tsc -p .\\tsconfig.json && tsc -p .\\packages\\contracts\\tsconfig.json && node .\\scripts\\dashboard-stamp.ts",
"build:clean": "node .\\scripts\\build-clean.ts",
"purge:temp": "node .\\scripts\\purge-temp-dirs-main.ts",
"bench:assistant:seed": "node .\\scripts\\assistant-bench\\seed.ts",
"bench:assistant": "node .\\scripts\\assistant-bench\\measure.ts",
"benchmark": "node .\\bench\\benchmark\\main.ts",
"benchmark:matrix": "node .\\bench\\benchmark-matrix\\main.ts",
"benchmark:repetition-guard": "node .\\scripts\\benchmark-repetition-guard.ts",
"probe:auto-approval": "node .\\scripts\\probe-auto-approval.ts",
"redteam:approval": "node .\\scripts\\approval-red-team\\main.ts",
"delete_logs": "node .\\scripts\\delete-logs.ts",
```
Delete `"build:test"`. Delete `"nodemonConfig"`, `"files"`, `"bundleDependencies"`. Remove `tsx`, `nodemon`, `esbuild` from `devDependencies`. The `test*` scripts are rewritten in Tasks 6–7. In `exl3:build-wheel` replace the leading `tsx` with `node`.

- [ ] **Step 3: Remaining tool references**

- `scripts/build-clean.ts` targets → `[join(repoRoot, '.tscache'), join(repoRoot, 'dashboard', '.tscache'), join(repoRoot, 'dashboard', 'dist')]`; doc comment: `/** Escape hatch for corrupted incremental state: removes typecheck caches and the dashboard build. */`
- `scripts/analysis/coverage-isolation-runner.ts`: replace the `tsxCli` spawn with `process.execPath` running the `.ts` file directly; drop `tsx@…` from the version fingerprint (`c8@…|node@…`).
- `scripts/run-benchmark-matrix.ps1:15,22`: delete `$tsxCli`; `$arguments = @($entrypoint)` (node runs the `.ts` entrypoint directly).
- `scripts/delete-logs.ts:5-7`, `scripts/profile-tool-loop-overhead.ts:16`: usage comments `tsx scripts/…` → `node scripts/…`.
- `scripts/start-dev.ts:140`: message stays `Run npm run build first.` (build is now the dashboard build — still correct).
- Delete `tests/package-files.test.ts` (asserted the removed `files` field).
- Run `npm install` (network) to prune the removed packages and update `package-lock.json`.

- [ ] **Step 4: Verify**

Run: `rg -n "\btsx\b|nodemon|esbuild|experimental-strip-types" package.json src scripts bench tests --glob "!*.tsx"` → only `scripts/build-test.ts` (deleted in Task 6) and `src/test-runner/live-instance-guard.ts` comments (rewritten in Task 6).
Run: `node --test tests/start-dev-ports.test.ts` → PASS.
Run: `npm run build` → dashboard stamp/vite build succeeds (or "up to date").
Run: `npm run start:status:stable:server` in background, confirm `http://127.0.0.1:4765/health` answers, stop it.
Run: `npm run typecheck` → exit 0.

---

### Task 6: node:test runner runs `.ts` directly

**Files:**
- Modify: `src/test-runner/test-targets.ts` (rewrite), `src/test-runner/run-tests.ts`, `src/test-runner/live-instance-guard.ts:16-28` (comment), `tests/test-targets.test.ts` (rewrite), `package.json` `test*` scripts, every test with a `dist/` path (list in Step 5)
- Delete: `scripts/build-test.ts`, `src/test-runner/test-build-state.ts`, `tests/test-build-state.test.ts`, `tests/test-build-artifacts.test.ts`, `tests/process/test-targets.test.ts`, `.test-build/` (generated)

- [ ] **Step 1: Rewrite the target tests first** — replace `tests/test-targets.test.ts` with:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { buildNodeTestArgs, resolveTestTargets } from '../src/test-runner/test-targets.ts';

const target = (...parts: string[]): string => path.join('tests', ...parts);

test('resolveTestTargets maps bare test basenames into the tests directory', () => {
  assert.deepEqual(resolveTestTargets(process.cwd(), ['mock-repo-search-loop.test.ts']), [target('mock-repo-search-loop.test.ts')]);
});

test('resolveTestTargets prefers one exact basename over partial matches', () => {
  assert.deepEqual(resolveTestTargets(process.cwd(), ['config.test.ts']), [target('config.test.ts'), target('process', 'config.test.ts')]);
});

test('resolveTestTargets maps bare prefixes to matching test files', () => {
  const resolved = resolveTestTargets(process.cwd(), ['dashboard-status-server']);
  assert.equal(resolved.includes(target('dashboard-status-server.run-logs.test.ts')), true);
  assert.equal(resolved.includes(target('dashboard-status-server.test.ts')), true);
  assert.equal(resolved.includes('dashboard-status-server'), false);
});

test('resolveTestTargets preserves explicit test paths', () => {
  assert.deepEqual(resolveTestTargets(process.cwd(), ['.\\tests\\mock-repo-search-loop.test.ts']), [target('mock-repo-search-loop.test.ts')]);
});

test('resolveTestTargets preserves option values while still resolving later positional targets', () => {
  const resolved = resolveTestTargets(process.cwd(), ['--test-name-pattern', 'runTaskLoop auto-accepts', 'mock-repo-search-loop.test.ts']);
  assert.deepEqual(resolved, ['--test-name-pattern', 'runTaskLoop auto-accepts', target('mock-repo-search-loop.test.ts')]);
});

test('buildNodeTestArgs adds default timeout and twelve-file concurrency before resolved targets', () => {
  assert.deepEqual(buildNodeTestArgs(process.cwd(), ['mock-repo-search-loop.test.ts']), [
    '--test-timeout=30000',
    '--test-concurrency=12',
    target('mock-repo-search-loop.test.ts'),
  ]);
});

test('buildNodeTestArgs defaults to top-level tests/*.test.ts when no explicit targets are provided', () => {
  const args = buildNodeTestArgs(process.cwd(), []);
  assert.equal(args[0], '--test-timeout=30000');
  assert.equal(args[1], '--test-concurrency=12');
  assert.equal(args.includes(target('test-targets.test.ts')), true);
  assert.equal(args.includes(target('dashboard-api.test.ts')), true);
  assert.equal(args.includes(target('fixtures', 'hangs-forever.test.ts')), false);
  assert.equal(args.some((value) => value.startsWith('--test-reporter')), false);
});

test('buildNodeTestArgs adds default top-level targets when only runner options are provided', () => {
  assert.equal(buildNodeTestArgs(process.cwd(), ['--test-concurrency=6']).includes(target('test-targets.test.ts')), true);
});

test('resolveTestTargets rejects a target that names no test file', () => {
  assert.throws(() => resolveTestTargets(process.cwd(), ['tests/not-a-real.test.ts']), /No test file matches/u);
  assert.throws(() => resolveTestTargets(process.cwd(), ['no-such-prefix-anywhere']), /No test file matches/u);
});

test('buildNodeTestArgs preserves explicit test runner overrides without duplicating defaults', () => {
  const args = buildNodeTestArgs(process.cwd(), ['--test-concurrency=32', '--test-reporter=spec', '--test-timeout=60000']);
  assert.deepEqual(args.filter((arg) => arg.startsWith('--test-concurrency=')), ['--test-concurrency=32']);
  assert.equal(args.includes('--test-timeout=30000'), false);
  assert.equal(args.includes('--test-reporter=spec'), true);
  assert.equal(args.includes('--test-timeout=60000'), true);
});

test('process option resolves every tests/process test and is not forwarded to node', () => {
  const args = buildNodeTestArgs(process.cwd(), ['--process']);
  assert.equal(args.includes(target('process', 'run-tests-watchdog.test.ts')), true);
  assert.equal(args.includes(target('config.test.ts')), false);
  assert.equal(args.includes('--process'), false);
});

test('default runs exclude the opt-in process suite', () => {
  const args = buildNodeTestArgs(process.cwd(), []);
  assert.equal(args.some((value) => value.startsWith(target('process') + path.sep)), false);
  assert.equal(args.includes(target('config.test.ts')), true);
});

test('a basename shared by the default and process suites resolves to both files', () => {
  assert.deepEqual(resolveTestTargets(process.cwd(), ['runtime-status-server.test.ts']), [
    target('process', 'runtime-status-server.test.ts'),
    target('runtime-status-server.test.ts'),
  ]);
});

test('perf option resolves tests/perf, runs one file at a time, and no other run includes it', () => {
  const perfTarget = target('perf', 'chat-stream-load.test.ts');
  const args = buildNodeTestArgs(process.cwd(), ['--perf']);
  assert.equal(args.includes(perfTarget), true);
  assert.equal(args.includes('--test-concurrency=1'), true);
  assert.equal(args.includes('--perf'), false);
  for (const other of [[], ['--process']]) assert.equal(buildNodeTestArgs(process.cwd(), other).includes(perfTarget), false);
});

test('a perf test named on its own still runs one file at a time', () => {
  assert.equal(buildNodeTestArgs(process.cwd(), ['chat-stream-load.test.ts']).includes('--test-concurrency=1'), true);
});
```
Run: `node --test tests/test-targets.test.ts` → FAIL (current module still expects `.test-build`).

- [ ] **Step 2: Rewrite `src/test-runner/test-targets.ts`** — replace the manifest plumbing with a source scan; keep the option handling:

```ts
import fs from 'node:fs';
import path from 'node:path';

type TestSuite = 'node' | 'process' | 'perf';
type TestEntry = { source: string; suite: TestSuite };

const TEST_RUNNER_OPTIONS_WITH_VALUES = new Set([
  '--test-name-pattern',
  '--test-skip-pattern',
  '--test-reporter',
  '--test-reporter-destination',
]);
const DEFAULT_TEST_TIMEOUT_MS = 30_000;
const DEFAULT_TEST_CONCURRENCY = 12;
const TESTS_DIRECTORY = 'tests';
const SUITE_OPTIONS = new Map<string, TestSuite>([['--process', 'process'], ['--perf', 'perf']]);
/** Perf tests measure CPU time, so no other test file may run beside them. */
const SERIAL_SUITE = 'perf';
const TIMEOUT_OPTION = '--test-timeout';
const CONCURRENCY_OPTION = '--test-concurrency';

function getTestSuite(source: string): TestSuite {
  if (source.startsWith('tests/process/')) return 'process';
  return source.startsWith('tests/perf/') ? 'perf' : 'node';
}

// Dot-directories under tests/ are per-run scratch homes, never test sources.
function collectTestSources(directory: string, relativeDirectory: string, sources: string[]): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.')) collectTestSources(path.join(directory, entry.name), relativePath, sources);
    } else if (entry.name.endsWith('.test.ts')) {
      sources.push(relativePath);
    }
  }
}

function listTestEntries(repoRoot: string): TestEntry[] {
  const sources: string[] = [];
  collectTestSources(path.join(repoRoot, TESTS_DIRECTORY), TESTS_DIRECTORY, sources);
  return sources.sort((left, right) => left.localeCompare(right)).map((source) => ({ source, suite: getTestSuite(source) }));
}

function hasPathSeparator(value: string): boolean {
  return value.includes('/') || value.includes('\\');
}

function toPlatformPath(source: string): string {
  return source.split('/').join(path.sep);
}

function sortedTargets(entries: TestEntry[]): string[] {
  return entries.map((entry) => toPlatformPath(entry.source)).sort((left, right) => left.localeCompare(right));
}

function resolveSingleTestTarget(tests: TestEntry[], rawValue: string): string[] {
  if (!rawValue) {
    throw new Error('A test target cannot be empty.');
  }
  if (hasPathSeparator(rawValue)) {
    const sourcePath = path.normalize(rawValue).split(path.sep).join('/').replace(/^\.\//u, '');
    const matched = tests.find((entry) => entry.source === sourcePath);
    if (matched) {
      return [toPlatformPath(matched.source)];
    }
    throw new Error(`No test file matches ${rawValue}.`);
  }
  // A basename can exist in more than one suite; an exact name selects every such file.
  const exactTargets = tests.filter((entry) => path.posix.basename(entry.source) === rawValue);
  const matchingTargets = exactTargets.length > 0 ? exactTargets : tests.filter((entry) => path.posix.basename(entry.source).includes(rawValue));
  if (matchingTargets.length === 0) {
    throw new Error(`No test file matches ${rawValue}.`);
  }
  return sortedTargets(matchingTargets);
}

function getDefaultTestTargets(tests: TestEntry[]): string[] {
  return sortedTargets(tests.filter((entry) => entry.suite === 'node' && !entry.source.slice(`${TESTS_DIRECTORY}/`.length).includes('/')));
}

function resolveTestArguments(repoRoot: string, rawArgs: string[]) {
  const tests = listTestEntries(repoRoot);
  const resolvedArgs: string[] = [];
  let targetCount = 0;
  let nextArgumentIsOptionValue = false;
  for (const rawArg of rawArgs) {
    if (nextArgumentIsOptionValue) {
      resolvedArgs.push(rawArg);
      nextArgumentIsOptionValue = false;
      continue;
    }
    if (TEST_RUNNER_OPTIONS_WITH_VALUES.has(rawArg)) {
      resolvedArgs.push(rawArg);
      nextArgumentIsOptionValue = true;
      continue;
    }
    const suite = SUITE_OPTIONS.get(rawArg);
    if (suite) {
      const suiteTargets = sortedTargets(tests.filter((entry) => entry.suite === suite));
      resolvedArgs.push(...suiteTargets);
      targetCount += suiteTargets.length;
      continue;
    }
    if (rawArg.startsWith('-')) {
      resolvedArgs.push(rawArg);
      continue;
    }
    const targets = resolveSingleTestTarget(tests, rawArg);
    resolvedArgs.push(...targets);
    targetCount += targets.length;
  }
  const serialTargets = new Set(sortedTargets(tests.filter((entry) => entry.suite === SERIAL_SUITE)));
  return { args: resolvedArgs, targetCount, tests, serial: resolvedArgs.some((arg) => serialTargets.has(arg)) };
}

export function resolveTestTargets(repoRoot: string, rawArgs: string[]): string[] {
  return resolveTestArguments(repoRoot, rawArgs).args;
}

function hasExplicitOption(rawArgs: string[], optionName: string): boolean {
  return rawArgs.some((rawArg) => rawArg === optionName || rawArg.startsWith(`${optionName}=`));
}

export function buildNodeTestArgs(repoRoot: string, rawArgs: string[]): string[] {
  const resolved = resolveTestArguments(repoRoot, rawArgs);
  const defaultArgs: string[] = [];
  if (!hasExplicitOption(rawArgs, TIMEOUT_OPTION)) {
    defaultArgs.push(`${TIMEOUT_OPTION}=${DEFAULT_TEST_TIMEOUT_MS}`);
  }
  if (!hasExplicitOption(rawArgs, CONCURRENCY_OPTION)) {
    defaultArgs.push(`${CONCURRENCY_OPTION}=${resolved.serial ? 1 : DEFAULT_TEST_CONCURRENCY}`);
  }
  return [
    ...defaultArgs,
    ...resolved.args,
    ...(resolved.targetCount > 0 ? [] : getDefaultTestTargets(resolved.tests)),
  ];
}
```

- [ ] **Step 3: Update `src/test-runner/run-tests.ts`**

- Delete `import { HERMETIC_FS_BUNDLE_PATH } from './test-build-state.ts';`.
- Guard URL: `const liveInstanceGuardUrl = pathToFileURL(path.resolve(scriptsDirectory, 'live-instance-guard.ts')).href;` and replace the comment above it with `// The guard travels in NODE_OPTIONS because catching a leak from a spawned CLI is its job; the URL is absolute so a child in a temp cwd resolves it too.`
- Delete the `// buildNodeTestArgs reaches readCurrentTestBuildManifest...` comment.
- `SIFTKIT_GUARD_HERMETIC_FS: pathToFileURL(path.resolve(repoRoot, 'tests', 'helpers', 'hermetic-fs.ts')).href,`
- `src/test-runner/live-instance-guard.ts:16-28`: replace the sentences about the compiled copy / tsx loader / dist with: `It is loaded as .ts by Node's type stripping; hermetic test files additionally load tests/helpers/hermetic-fs.ts, whose URL arrives as env.`

- [ ] **Step 4: Delete build-state code and its tests**

Delete `scripts/build-test.ts`, `src/test-runner/test-build-state.ts`, `tests/test-build-state.test.ts`, `tests/test-build-artifacts.test.ts`, `tests/process/test-targets.test.ts`, the `.test-build/` directory. Remove `scripts/build-test.ts` from `tsconfig.scripts.json` if still listed.

- [ ] **Step 5: Repoint tests from `dist/**/*.js` to `src/**/*.ts`**

Rule: `dist/<p>.js` → `src/<p>.ts`; `dist/test-runner/run-tests.js` → `src/test-runner/run-tests.ts`. Sites:
`tests/cli-stdin-input.test.ts:11`, `tests/helpers/flush-worker-fixture.ts:20`, `tests/process/live-instance-guard.test.ts:22,137` (+ comment 373), `tests/process/repo-agent-cli.test.ts:22`, `tests/process/run-tests-watchdog.test.ts:47,81`, `tests/process/runtime-cli.test.ts:37`, `tests/process/status-server-shutdown-exit.test.ts:52`, `tests/process/web-search.test.ts:9`, `tests/repo-search-status-server.test.ts:1009`, `tests/_runtime-helpers.ts:1265`, `tests/summary-status-server.test.ts:30` (reads the route source text — adjust its regexes if they matched compiled-JS shapes), `tests/SiftKit.Tests.ps1:664`.
Leave `tests/activity-summary-collector.test.ts:155` (sample command text, not a path the test opens) and `tests/test-hygiene-gate.test.ts:30` (still a valid "never import dist" rule).
Then: `rg -n "'dist'|dist[/\\\\]" tests src scripts bin SiftKit` → only `src/repo-search/command-safety.ts:8` (directory-name list, unrelated) and the two lines left above.

- [ ] **Step 6: Rewrite test scripts in `package.json`**

```json
"test": "tsc -p .\\tsconfig.test.json && node .\\src\\test-runner\\run-tests.ts",
"test:process": "tsc -p .\\tsconfig.test.json && node .\\src\\test-runner\\run-tests.ts --process",
"test:perf": "tsc -p .\\tsconfig.test.json && node .\\src\\test-runner\\run-tests.ts --perf",
"test:coverage": "npx c8 --include=\"src/**/*.ts\" --exclude=\"node_modules/**\" --exclude=\"tests/**\" --reporter=text --reporter=text-summary node .\\src\\test-runner\\run-tests.ts",
"test:coverage:llm": "npx c8 --include=\"src/llm-protocol/**/*.ts\" --include=\"src/agent-loop/**/*.ts\" --exclude=\"node_modules/**\" --reporter=text --reporter=text-summary node .\\src\\test-runner\\run-tests.ts",
```
`test:live`: drop `npm run build && `, replace `npx tsx --test` with `node --test`, and point at `.\\tests\\process\\runtime-cli.test.ts` (the old `.\\tests\\runtime-cli.test.ts` path does not exist).
`test:live:approval-cache-chain`, `test:live:approval-verdict-budget`, `test:live:repo-agent-compaction-replay`: drop `npm run build:test && `; `node .\\dist\\test-runner\\run-tests.js` → `node .\\src\\test-runner\\run-tests.ts`.
`test:dashboard` is rewritten in Task 7; until then delete it.

- [ ] **Step 7: Verify**

Run: `node --test tests/test-targets.test.ts` → PASS.
Run: `npm test 2>&1 | Select-Object -Last 30` → same pass/fail as baseline minus deleted test files (the 6 JSX-reaching root tests fail here with `.tsx`/JSX errors — they move in Task 7; nothing else may newly fail).
Run: `npm run test:process 2>&1 | Select-Object -Last 30` → matches baseline.
Run: `npm run typecheck` → exit 0.

---

### Task 7: Dashboard tests on Vitest

**Files:**
- Create: `dashboard/vitest.config.ts`, `.scratch/native-ts/move-tests.ts`, `.scratch/native-ts/port-to-vitest.ts`
- Move: the 6 JSX-reaching root tests → `dashboard/tests/`
- Modify: all `dashboard/tests/**/*.test.{ts,tsx}`, root `package.json`, `tsconfig.test.json` (`exclude`), `dashboard/tsconfig.test.json` (`include`, `types`)

- [ ] **Step 1: Install Vitest at the root** (run from repo root so the bin is hoisted and `process.cwd()` stays the repo root, which the tests assume)

Run: `npm install -D vitest@^4`
Create `dashboard/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    environment: 'node',
    restoreMocks: true,
    testTimeout: 30_000,
  },
});
```
Root `package.json`: `"test:dashboard": "tsc -p .\\dashboard\\tsconfig.test.json && vitest run --config .\\dashboard\\vitest.config.ts"` (type gate replaces the old build-test `tsc` gate).

- [ ] **Step 2: Move the 6 JSX-reaching tests** — `.scratch/native-ts/move-tests.ts` re-resolves every relative specifier against the new directory:

```ts
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const MOVED = ['dashboard-app-refresh', 'dashboard-benchmark-controller', 'dashboard-model-presets-section', 'dashboard-presets-section', 'dashboard-runs-controller-e2e', 'dashboard-settings-controller']
  .map((name) => ({ from: path.resolve('tests', `${name}.test.ts`), to: path.resolve('dashboard', 'tests', `${name}.test.ts`) }));

for (const { from, to } of MOVED) {
  const text = fs.readFileSync(from, 'utf8');
  const source = ts.createSourceFile(from, text, ts.ScriptTarget.Latest, true);
  const edits: { start: number; end: number; text: string }[] = [];
  const visit = (node: ts.Node): void => {
    const literal = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
      : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0]
        : undefined;
    if (literal !== undefined && ts.isStringLiteral(literal) && /^\.{1,2}\//u.test(literal.text)) {
      const relative = path.relative(path.dirname(to), path.resolve(path.dirname(from), literal.text)).split(path.sep).join('/');
      edits.push({ start: literal.getStart(source) + 1, end: literal.getEnd() - 1, text: relative.startsWith('.') ? relative : `./${relative}` });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  let output = text;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  }
  fs.writeFileSync(to, output, 'utf8');
  fs.rmSync(from);
}
```
Run: `node .scratch/native-ts/move-tests.ts`, then `git add -N dashboard/tests` is NOT needed (no commits). Check none of the 6 used `process.cwd()`-relative paths that assumed `tests/` (grep `__dirname|import.meta.dirname|tests'` in them and fix by hand).

- [ ] **Step 3: Port node:test API to Vitest** — `.scratch/native-ts/port-to-vitest.ts` handles the import lines; the context-API sites are ported by hand:

```ts
import fs from 'node:fs';
import path from 'node:path';

function listTests(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listTests(entryPath);
    return /\.test\.tsx?$/u.test(entry.name) ? [entryPath] : [];
  });
}

const leftovers: string[] = [];
for (const file of listTests(path.resolve('dashboard', 'tests'))) {
  const text = fs.readFileSync(file, 'utf8');
  const next = text
    .replace(/^import test, \{ ([^}]+) \} from 'node:test';$/mu, "import { test, $1 } from 'vitest';")
    .replace(/^import test from 'node:test';$/mu, "import { test } from 'vitest';")
    .replace(/^import \{ ([^}]+) \} from 'node:test';$/mu, "import { $1 } from 'vitest';");
  if (next !== text) fs.writeFileSync(file, next, 'utf8');
  if (/node:test|\bt\.(after|mock|signal)\b|\{ concurrency: false \}/u.test(next)) leftovers.push(file);
}
process.stdout.write(`${leftovers.join('\n')}\n`);
```
Run: `node .scratch/native-ts/port-to-vitest.ts`. For each listed file, port by hand:
| node:test | Vitest |
|---|---|
| `test(name, async (t) => { … t.after(fn) … })` | `test(name, async () => { … onTestFinished(fn) … })`, import `onTestFinished` |
| `t.mock.method(obj, 'm', impl)` | `vi.spyOn(obj, 'm').mockImplementation(impl)` (restored by `restoreMocks`) |
| `t.mock.method(obj, 'm')` | `vi.spyOn(obj, 'm')` |
| `t.mock.timers.enable(…)` | `vi.useFakeTimers()` + `onTestFinished(() => { vi.useRealTimers(); })` |
| `t.mock.timers.tick(ms)` | `vi.advanceTimersByTime(ms)` |
| `t.signal` | `test(name, async ({ signal }) => …)` |
| `test(name, { concurrency: false }, fn)` | `test(name, fn)` (Vitest runs a file's tests sequentially) |
| `test(name, { timeout: 10000 }, fn)` | `test(name, { timeout: 10_000 }, fn)` (same shape) |
`mock.calls` keeps the same shape (`consoleError.mock.calls` in `chat-tab.test.tsx`); any `mock.callCount()` → `mock.calls.length`. Rerun the script until it prints nothing.

- [ ] **Step 4: Typecheck wiring**

- `tsconfig.test.json` `exclude`: remove the 6 moved files; keep `tests/dashboard-api.test.ts` and `tests/dashboard-toasts.test.ts` (still Node tests, typechecked by the dashboard project).
- `dashboard/tsconfig.test.json` `include`: remove the 6 moved `../tests/...` entries (now covered by `"tests"`); add `"vitest"` is not needed in `types` (tests import from `'vitest'` explicitly).

- [ ] **Step 5: Verify parity**

Run: `npm run test:dashboard 2>&1 | Select-Object -Last 25` → passed count == Task 0 parity target, 0 failed.
Run: `npm test 2>&1 | Select-Object -Last 30` → no JSX failures remain; matches baseline otherwise.
Run: `npm run typecheck` → exit 0.

---

### Task 8: Global install links the repo

**Files:**
- Modify: `scripts/refresh-global.ps1`, `README.md` (refresh-global paragraph handled in Task 9)

- [ ] **Step 1: Replace pack+tarball with a linked install**

In `scripts/refresh-global.ps1`:
- Delete `Get-SiftKitPackageTarballName`, `$tarballName = …`, and the `Packing current repo...` block.
- `Stop-ExistingGlobalSiftKitStatusServer`: match the repo's real entrypoint instead of the global package copy:
```powershell
    $statusServerPath = Join-Path $script:RepoRoot 'src\status-server\main.ts'
```
  (drop the `$globalPrefix` / `$globalPackageRoot` lookups in that function).
- Replace the install block with:
```powershell
Write-Host 'Linking the repo as the global siftkit package...'
# Node refuses to strip types under node_modules; a linked install resolves to this checkout's realpath instead.
Invoke-RetryableCommand -FilePath 'npm.cmd' -ArgumentList @('i', '-g', $script:RepoRoot, '--no-audit', '--offline', '--loglevel', 'error') -Description 'Linking repo globally'
```
- Keep the `npm install --offline` reconcile, desktop build, and all smoke checks unchanged.
- Update the comments mentioning `bundleDependencies` / tarball accordingly (1–2 lines each).

- [ ] **Step 2: Verify end to end**

Run: `npm run refresh-global` → completes with `Global siftkit public CLI smoke checks passed.` (PowerShell `--help`, `repo-search --help`, quote round-trip, Git Bash sh-shim round-trip).
Run: `(Get-Item "$(npm prefix -g)\node_modules\siftkit").LinkType` → `Junction` or `SymbolicLink`.
If the sh-shim check fails with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, stop and report: it means Node did not realpath the bin — do not add a loader workaround.

---

### Task 9: Living docs

**Files:** Modify `README.md` (lines ~22, ~255-270, and any other `dist`/`npm run build`/`build:test`/`tsx` mention)

- [ ] **Step 1: Update**

- Line ~22: `npm run refresh-global` builds the dashboard, links this checkout as the global package, and smoke-checks the Git Bash sh shim (`src/cli/main.ts` carries `#!/usr/bin/env node`) and double-quote round-trips.
- Build section (~261): `npm run build` builds only the dashboard (Vite); Node runs the TypeScript sources directly (Node ≥ 26), so there is no CLI/server build.
- Status-server dev line (~264): `npm run start:status` runs `node --watch` on `src/status-server/main.ts`.
- Testing: `npm test` runs node:test on `tests/**/*.test.ts` directly; `npm run test:dashboard` runs Vitest.
- State the Node requirement (`>= 26`) where install prerequisites are listed; add `"engines": { "node": ">=26" }` to root `package.json`.

- [ ] **Step 2: Verify**

Run: `rg -n "dist/|dist\\\\|npm run build:test|\btsx\b|nodemon" README.md` → no CLI-build references remain (dashboard `dashboard/dist` mentions are fine).

---

### Task 10: Full verification and cleanup

- [ ] **Step 1: Remove generated artifacts** (confirm with the user before deleting): `dist/`, `packages/contracts/dist/`, `.test-build/`, `.tscache/main-build.tsbuildinfo`, `*.tgz` in repo root.
- [ ] **Step 2: Full suite**

```
npm run typecheck
npm run lint
npm test
npm run test:process
npm run test:perf
npm run test:dashboard
npm run build
.\bin\siftkit.cmd --help
```
All green relative to the Task 0 baseline. Record `npm test` and `npm run test:dashboard` wall times next to the baseline and report the delta.
- [ ] **Step 2b: Prove the type gates fail loudly**

Temporarily append `export const typeGateProbe: number = 'x';` to `src/lib/paths.ts`; confirm `npm run build`, `npm test` and `npm run typecheck` each exit non-zero with TS2322 before running anything. Repeat with a probe in `tests/cli-shebang.test.ts` (`npm test`) and in `dashboard/tests/api-stream.test.ts` (`npm run test:dashboard`). Remove every probe.

- [ ] **Step 3: Final greps**

`rg -n "\btsx\b|nodemon|esbuild|experimental-strip-types|\.test-build|build:test|sync-dist-runtime|test-build-state" --glob "!docs/**" --glob "!node_modules/**" --glob "!*.tsx" .` → nothing (except `package-lock.json` entries pulled in transitively by Vite/Vitest).
- [ ] **Step 4: Cleanup** — delete `.scratch/native-ts/`.
