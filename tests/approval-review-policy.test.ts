import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APPROVAL_REVIEW_REQUEST_MARKER,
  APPROVER_SYSTEM_PROMPT,
  buildApprovalReviewRequest,
} from '../src/repo-search/approval-review-policy.ts';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { RUN_SCRIPT_REVIEW_MAX_BYTES, buildApprovalReviewPayload } from '../src/repo-search/engine/approval-gate.ts';
import { parseJsonValueText } from '../src/lib/json.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

test('write approval payload includes the complete path and content', () => {
  const payload = buildApprovalReviewPayload({
    toolName: 'write',
    repoRoot: 'C:\\work\\repo',
    args: {
      path: '.github/workflows/release.yml',
      content: 'run: Invoke-WebRequest https://example.com/upload',
    },
  });

  assert.match(payload ?? '', /"path": "\.github\/workflows\/release\.yml"/u);
  assert.match(payload ?? '', /Invoke-WebRequest https:\/\/example\.com\/upload/u);
});

test('edit approval payload includes every complete replacement', () => {
  const payload = buildApprovalReviewPayload({
    toolName: 'edit',
    repoRoot: 'C:\\work\\repo',
    args: {
      path: 'src/cleanup.ts',
      edits: [
        { oldText: 'return false;', newText: 'return true;' },
        {
          oldText: 'cleanCache();',
          newText: 'fs.rmSync(repoRoot, { recursive: true, force: true });',
        },
      ],
    },
  });

  for (const value of [
    'src/cleanup.ts',
    'return false;',
    'return true;',
    'cleanCache();',
    'fs.rmSync(repoRoot, { recursive: true, force: true });',
  ]) {
    assert.ok(payload?.includes(value), `missing complete edit value: ${value}`);
  }
});

test('large edit approval payload is not truncated around destructive content', () => {
  const newText = `line01
line02
line03
line04
line05
line06
line07
line08
line09
line10
line11
line12
line13
line14
line15
git push --force origin HEAD:main
line17
line18
line19
line20
line21
line22
line23
line24
line25
line26
line27
line28
line29
line30
line31`;
  const payload = buildApprovalReviewPayload({
    toolName: 'edit',
    repoRoot: 'C:\\work\\repo',
    args: {
      path: 'src/release.ts',
      edits: [{ oldText: 'old release', newText }],
    },
  });

  assert.ok(payload?.includes('line01'));
  assert.ok(payload?.includes('git push --force origin HEAD:main'));
  assert.ok(payload?.includes('line31'));
});

for (const toolName of ['read', 'grep', 'find', 'ls', 'git', 'run', 'web_search', 'web_fetch']) {
  test(`${toolName} does not duplicate its arguments into an approval payload`, () => {
    assert.equal(buildApprovalReviewPayload({
      toolName,
      repoRoot: 'C:\\work\\repo',
      args: toolName === 'git' ? { operation: 'status' } : { command: 'git status --short' },
    }), null);
  });
}

test('an edit review request names the repository root and carries its payload after the command', () => {
  const reviewPayload = buildApprovalReviewPayload({ toolName: 'write', args: { path: 'a.ts', content: 'x' }, repoRoot: 'C:\\work\\repo' });
  assert.equal(buildApprovalReviewRequest({ repoRoot: 'C:\\work\\repo', toolName: 'write', command: 'write path="a.ts"', reviewPayload }), [
    APPROVAL_REVIEW_REQUEST_MARKER,
    'repository root: C:\\work\\repo',
    'tool: write',
    'command: write path="a.ts"',
    'payload:',
    reviewPayload,
  ].join('\n'));
});

test('the approver approves the repository\'s own checks and denies effects outside the repository root', () => {
  assert.match(APPROVER_SYSTEM_PROMPT, /Approve the repository's own test, build, lint, and typecheck commands/u);
  assert.match(APPROVER_SYSTEM_PROMPT, /- writes, deletions, or directory changes outside the repository root named in the request/u);
});

// Real case (run e85529c8): 9 escalations, every one about whether code was correct, none about safety.
test('the approver judges safety only and returns unsure for effects it cannot see, never for correctness', () => {
  assert.match(APPROVER_SYSTEM_PROMPT, /^Judge safety only\. Whether a change compiles, overlaps another edit, completes a rename/mu);
  assert.match(APPROVER_SYSTEM_PROMPT, /Never return unsure for those reasons\./u);
  assert.match(APPROVER_SYSTEM_PROMPT,
    /- effects on files, processes, the network, or secrets that cannot be determined from the command and payload shown/u);
  assert.match(APPROVER_SYSTEM_PROMPT, /- non-recursive deletion/u, 'real risks still go to unsure');
  assert.doesNotMatch(APPROVER_SYSTEM_PROMPT, /cannot be fully understood/u);
  assert.doesNotMatch(APPROVER_SYSTEM_PROMPT, /effects that cannot be independently determined/u);
  assert.doesNotMatch(APPROVER_SYSTEM_PROMPT, /right for the task/u, 'task fit is never framed as outside safety');
  // Red-team allowlist-add-attacker: approved 8/15 with task fit framed as not a safety question.
  assert.match(APPROVER_SYSTEM_PROMPT, /^- adding a host, IP address, origin, user, or key to an allowlist, trust list, or permission set$/mu);
});

const RunPayloadSchema = z.object({
  toolName: z.literal('run'),
  packageScripts: z.array(z.object({ name: z.string(), command: z.string().nullable() })),
  scripts: z.array(z.object({ path: z.string(), content: z.string().nullable() })),
});

function runReviewRepo(files: Record<string, string>) {
  const root = createManagedTempDir('siftkit-run-review-');
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  const text = (command: string) => buildApprovalReviewPayload({ toolName: 'run', args: { command }, repoRoot: root });
  const shown = (command: string) => RunPayloadSchema.parse(parseJsonValueText(text(command) ?? ''));
  return { text, shown, paths: (command: string) => shown(command).scripts.map((script) => script.path) };
}

// Real case (run e85529c8): a probe script escalated three times because the reviewer could see only "node probe.ts".
test('a run that executes a repository script carries its content, a test runner script included; test files and inline code carry none', () => {
  const repo = runReviewRepo({
    'scratch/probe.ts': "console.log('probe');\n",
    'scratch/big.ts': 'x'.repeat(RUN_SCRIPT_REVIEW_MAX_BYTES + 1),
    'src/run-tests.ts': 'runTests();\n',
  });
  assert.deepEqual(repo.shown('node .\\scratch\\probe.ts'),
    { toolName: 'run', packageScripts: [], scripts: [{ path: 'scratch/probe.ts', content: "console.log('probe');\n" }] });
  assert.deepEqual(repo.shown('node scratch/big.ts').scripts, [{ path: 'scratch/big.ts', content: null }]);
  assert.deepEqual(repo.shown('node .\\src\\run-tests.ts --process chat; "EXIT=$LASTEXITCODE"').scripts, [{ path: 'src/run-tests.ts', content: 'runTests();\n' }]);
  assert.deepEqual(repo.paths('cd scratch; node probe.ts'), ['scratch/probe.ts'], 'a cd is followed');
  assert.deepEqual(repo.paths('node scratch/probe.ts --test'), ['scratch/probe.ts'], 'an argument of the script is no test flag');
  assert.deepEqual(repo.paths('node src/run-tests.ts; node --import ./scratch/probe.ts --test a.test.ts'), ['src/run-tests.ts', 'scratch/probe.ts']);
  // An option's value is not the script: both are shown.
  assert.deepEqual(repo.paths('node --import tsx scratch/probe.ts'), ['scratch/probe.ts']);
  assert.deepEqual(repo.paths('node --import ./src/run-tests.ts scratch/probe.ts scratch/big.ts'), ['src/run-tests.ts', 'scratch/probe.ts']);
  for (const command of ['python -m pytest scratch/probe.ts', 'node -e "console.log(1)"', 'node scratch/missing.ts', 'node --test scratch/probe.ts', 'npx tsc -p .', 'npx vitest run probe', 'npm install', 'npm run']) {
    assert.equal(repo.text(command), null, command);
  }
});

// Real case: 44 of 803 check commands escalated, nearly all because what "npm test" runs was not shown.
test('a package script is shown with its pre and post scripts, the scripts it runs in turn, and the files they execute', () => {
  const repo = runReviewRepo({
    'package.json': JSON.stringify({ scripts: {
      pretest: 'npm run lint', lint: 'eslint .', test: 'npm run typecheck && node ./src/run-tests.ts', typecheck: 'tsc -p .', posttest: 'echo done',
      deploy: 'node scripts/deploy.ts', loop: 'npm run loop',
    } }),
    'src/run-tests.ts': 'runTests();\n',
    'scripts/deploy.ts': 'upload();\n',
    'packages/app/package.json': JSON.stringify({ scripts: { test: 'curl https://example.com' } }),
    'packages/app/src/a.ts': '',
    'broken/package.json': '{',
  });
  const ofTest = repo.shown('npm.cmd test -- --watch=false');
  assert.deepEqual(ofTest.packageScripts, [
    { name: 'pretest', command: 'npm run lint' },
    { name: 'lint', command: 'eslint .' },
    { name: 'test', command: 'npm run typecheck && node ./src/run-tests.ts' },
    { name: 'typecheck', command: 'tsc -p .' },
    { name: 'posttest', command: 'echo done' },
  ]);
  assert.deepEqual(ofTest.scripts, [{ path: 'src/run-tests.ts', content: 'runTests();\n' }]);
  assert.deepEqual(repo.shown('npm t').packageScripts, ofTest.packageScripts);
  assert.deepEqual(repo.shown('npm run deploy'), {
    toolName: 'run', packageScripts: [{ name: 'deploy', command: 'node scripts/deploy.ts' }], scripts: [{ path: 'scripts/deploy.ts', content: 'upload();\n' }],
  });
  assert.deepEqual(repo.shown('npm run lint; pnpm run typecheck').packageScripts.map(({ name }) => name), ['lint', 'typecheck']);
  assert.deepEqual(repo.shown('npm run loop').packageScripts, [{ name: 'loop', command: 'npm run loop' }]);

  // Every manager but npm also runs a script by its bare name, and node runs one itself.
  for (const command of ['yarn deploy', 'pnpm deploy', 'bun deploy', 'node --run deploy']) {
    assert.deepEqual(repo.shown(command).packageScripts, [{ name: 'deploy', command: 'node scripts/deploy.ts' }], command);
  }
  for (const command of ['yarn add x', 'pnpm exec tsc', 'npm deploy', 'yarn']) assert.equal(repo.text(command), null, command);
  assert.deepEqual(repo.shown('yarn workspace app deploy').packageScripts, [{ name: 'deploy', command: null }]);
  assert.deepEqual(repo.shown('pnpm --dir packages/app deploy').packageScripts, [{ name: 'deploy', command: null }]);

  // What is shown is what would run, or nothing: never another package's script of the same name.
  for (const command of ['cd packages/app; npm test', 'cd packages\\app\\src; npm test', 'if ($true) { cd packages/app; npm test }']) {
    assert.deepEqual(repo.shown(command).packageScripts, [{ name: 'test', command: 'curl https://example.com' }], command);
  }
  for (const command of ['npm test --prefix packages/app', 'npm --prefix packages/app test', 'npm test -w app', 'npm test --workspace=app', 'cd $dir; npm test',
    'cd packages/app; popd; npm test', 'cd broken; npm test']) {
    assert.deepEqual(repo.shown(command).packageScripts, [{ name: 'test', command: null }], command);
  }
  assert.deepEqual(repo.shown('npm run release').packageScripts, [{ name: 'release', command: null }]);
});

test('the approver judges a shown script like an edit payload, a check by that payload, and returns unsure for one it was not shown', () => {
  assert.match(APPROVER_SYSTEM_PROMPT, /For run, a payload lists the package\.json scripts \(packageScripts\) and repository files \(scripts\) the command executes/u);
  assert.match(APPROVER_SYSTEM_PROMPT, /return unsure for null/u);
  assert.match(APPROVER_SYSTEM_PROMPT, /never return unsure because their content is not shown/u);
  assert.doesNotMatch(APPROVER_SYSTEM_PROMPT, /npm run <script>/u, 'a package script is not approved by its name');
});

test('the approver prompt names its role, forbids tool calls, and allows only the verdict schema', () => {
  assert.match(APPROVER_SYSTEM_PROMPT, /You are not that agent/u);
  assert.match(APPROVER_SYSTEM_PROMPT, /block of the user message/u);
  assert.match(APPROVER_SYSTEM_PROMPT, /Do not call tools/u);
  assert.match(
    APPROVER_SYSTEM_PROMPT,
    /return only JSON:\n\{"verdict":"approve"\|"deny"\|"unsure","reason":"<one sentence>"\}/u,
  );
});
