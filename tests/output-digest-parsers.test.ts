import assert from 'node:assert/strict';
import test from 'node:test';

import { digestToolOutput } from '../src/output-digest/digest.ts';
import type { DigestTool, ToolDigest } from '../src/output-digest/types.ts';
import { listDigestFixtures, readDigestFixture } from './helpers/output-digest-fixtures.ts';

type FailureRow = readonly [name: string, location: string | null, message: readonly string[]];

function digest(tool: DigestTool, failed: boolean, counts: readonly (readonly [string, number])[], failures: readonly FailureRow[]): ToolDigest {
  return {
    tool, failed,
    counts: counts.map(([label, value]) => ({ label, value })),
    failures: failures.map(([name, location, message]) => ({ name, location, message: [...message] })),
  };
}

/** Each captured fixture's exact digests: one per tool whose output it holds, in `digestToolOutput` order. */
const EXPECTED: Record<string, ToolDigest[]> = {
  'node-test/bad-path.txt': [
    digest('node:test', true, [['tests', 1], ['pass', 0], ['fail', 1], ['cancelled', 0], ['skipped', 0], ['todo', 0]], [
      ['fail', 'fail:1:1', ["Error: Cannot find module 'C:\\tmp\\rsx\\output-digest-capture\\node\\fail'"]],
    ]),
  ],
  'node-test/fail.txt': [
    digest('node:test', true, [['tests', 7], ['pass', 2], ['fail', 5], ['cancelled', 0], ['skipped', 0], ['todo', 0]], [
      ['fail\\load.test.mjs', 'C:/tmp/rsx/output-digest-capture/node/fail/load.test.mjs:1', ["SyntaxError: The requested module './nothing-here.mjs' does not provide an export named 'missing'"]],
      ['compares arrays', 'C:/tmp/rsx/output-digest-capture/node/fail/math.test.mjs:4:40', ['AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:', '+ actual - expected', '  [', "    'model-a',", "    'model-b',", "+   'model-a'", '  ]']],
      ['counts attempts', 'C:/tmp/rsx/output-digest-capture/node/fail/math.test.mjs:5:40', ['AssertionError [ERR_ASSERTION]: the refused dispatch started no child', '1 !== 2']],
      ['inner throws', 'C:/tmp/rsx/output-digest-capture/node/fail/math.test.mjs:8:46', ["TypeError: Cannot read properties of undefined (reading 'runId')"]],
    ]),
  ],
  'node-test/noisy-e2e-fail.txt': [
    digest('node:test', true, [['tests', 25], ['pass', 23], ['fail', 2], ['cancelled', 0], ['skipped', 0], ['todo', 0]], [
      ['one conversation plans, dispatches a writer, reviews it, and finishes; the parent releases its model while the child works', 'C:/Users/denys/Documents/GitHub/SiftKit/tests/process/zz-fit-demo.e2e.test.ts:188:12', ['AssertionError [ERR_ASSERTION]: the parent on A, its child on B, then the parent resumes on A', '+ actual - expected', '  [', "    'model-a',", "    'model-b',", "+   'model-a'", '  ]']],
      ['while a child awaits a decision, code refuses a check, a second dispatch, and a plan change, and decide resumes it', 'C:/Users/denys/Documents/GitHub/SiftKit/tests/process/zz-fit-demo.e2e.test.ts:459:10', ['AssertionError [ERR_ASSERTION]: the refused dispatch started no child', '1 !== 2']],
    ]),
  ],
  'node-test/pass.txt': [
    digest('node:test', false, [['tests', 5], ['pass', 4], ['fail', 0], ['cancelled', 0], ['skipped', 1], ['todo', 0]], []),
  ],
  'vitest/fail.txt': [
    digest('vitest', true, [['tests', 4], ['failed', 3], ['passed', 1]], [
      ['broken.test.ts > never runs', 'broken.test.ts:3:24', ['TypeError: missing is not a function']],
      ['math.test.ts > math > compares arrays', 'math.test.ts:4:75', ["AssertionError: expected [ 'model-a', 'model-b', 'model-a' ] to deeply equal [ 'model-a', 'model-b' ]", '- Expected', '+ Received', '  [', '    "model-a",', '    "model-b",', '+   "model-a",', '  ]']],
      ['math.test.ts > math > throws', 'math.test.ts:5:30', ["TypeError: Cannot read properties of undefined (reading 'runId')"]],
    ]),
  ],
  'vitest/pass.txt': [
    digest('vitest', false, [['tests', 3], ['passed', 2], ['skipped', 1]], []),
  ],
  'jest/fail.txt': [
    digest('jest', true, [['tests', 4], ['failed', 3], ['passed', 1]], [
      ['math › compares arrays', 'math.test.js:3:77', ['expect(received).toEqual(expected) // deep equality', '- Expected  - 0', '+ Received  + 1', '  Array [', '    "model-a",', '    "model-b",', '+   "model-a",', '  ]']],
      ['math › throws', 'math.test.js:4:32', ["TypeError: Cannot read properties of undefined (reading 'runId')"]],
      ['never runs', 'broken.test.js:2:26', ['TypeError: missing is not a function']],
    ]),
  ],
  'jest/pass.txt': [
    digest('jest', false, [['tests', 3], ['skipped', 1], ['passed', 2]], []),
  ],
  'pytest/collection-error.txt': [
    digest('pytest', true, [['error', 1]], [
      ['ERROR collecting test_broken.py', 'test_broken.py:1', ["ModuleNotFoundError: No module named 'nothing_here'"]],
    ]),
  ],
  'pytest/fail.txt': [
    digest('pytest', true, [['failed', 2], ['passed', 1]], [
      ['test_compares_lists', 'test_math.py:4', ["AssertionError: assert ['model-a', '...b', 'model-a'] == ['model-a', 'model-b']", "  Left contains one more item: 'model-a'", '  Use -v to get more diff']],
      ['TestSuite.test_throws', 'test_math.py:7', ["TypeError: Cannot read properties of None (reading 'run_id')"]],
    ]),
  ],
  'pytest/pass.txt': [
    digest('pytest', false, [['passed', 2], ['skipped', 1]], []),
  ],
  'dotnet-test/fail-terminal-logger.txt': [
    digest('dotnet test', true, [['tests', 3], ['failed', 2], ['passed', 1], ['skipped', 0]], [
      ['MathTests.UnitTest1.Throws', 'C:\\tmp\\rsx\\output-digest-capture\\dotnet\\MathTests\\UnitTest1.cs:12', ['System.InvalidOperationException : The store is closed.']],
      ['MathTests.UnitTest1.Compares', 'C:\\tmp\\rsx\\output-digest-capture\\dotnet\\MathTests\\UnitTest1.cs:9', ['Assert.Equal() Failure: Collections differ', 'Expected: ["model-a", "model-b"]', 'Actual:   ["model-a", "model-b", "model-a"]', '↑ (pos 2)']],
    ]),
    digest('msbuild', false, [['errors', 0], ['warnings', 0]], []),
  ],
  'dotnet-test/fail.txt': [
    digest('dotnet test', true, [['tests', 3], ['failed', 2], ['passed', 1], ['skipped', 0]], [
      ['MathTests.UnitTest1.Throws', 'C:\\tmp\\rsx\\output-digest-capture\\dotnet\\MathTests\\UnitTest1.cs:12', ['System.InvalidOperationException : The store is closed.']],
      ['MathTests.UnitTest1.Compares', 'C:\\tmp\\rsx\\output-digest-capture\\dotnet\\MathTests\\UnitTest1.cs:9', ['Assert.Equal() Failure: Collections differ', 'Expected: ["model-a", "model-b"]', 'Actual:   ["model-a", "model-b", "model-a"]', '↑ (pos 2)']],
    ]),
  ],
  'dotnet-test/pass.txt': [
    digest('dotnet test', false, [['tests', 3], ['failed', 0], ['passed', 2], ['skipped', 1]], []),
  ],
  'msbuild/fail-terminal-logger.txt': [
    digest('msbuild', true, [['errors', 2], ['warnings', 0]], [
      ["CS0029: Cannot implicitly convert type 'string' to 'int'", 'C:\\tmp\\rsx\\output-digest-capture\\dotnet\\MathTests\\Broken.cs:5:41', []],
      ["CS0103: The name 'y' does not exist in the current context", 'C:\\tmp\\rsx\\output-digest-capture\\dotnet\\MathTests\\Broken.cs:5:56', []],
    ]),
  ],
  'msbuild/fail.txt': [
    digest('msbuild', true, [['errors', 2], ['warnings', 0]], [
      ["CS0029: Cannot implicitly convert type 'string' to 'int'", 'C:\\tmp\\rsx\\output-digest-capture\\dotnet\\MathTests\\Broken.cs:5:41', []],
      ["CS0103: The name 'y' does not exist in the current context", 'C:\\tmp\\rsx\\output-digest-capture\\dotnet\\MathTests\\Broken.cs:5:56', []],
    ]),
  ],
  'msbuild/pass.txt': [
    digest('msbuild', false, [['errors', 0], ['warnings', 0]], []),
  ],
  'go-test/build-error.txt': [
    digest('go test', true, [['packages', 2], ['ok', 0], ['failed', 2]], [
      ['TestAdd', 'calc_test.go:7', ['Add(2, 2) = 4, want 4']],
      ['TestTable/neg', 'calc_test.go:15', ['got -2, want -3']],
      ['cannot use "one" (untyped string constant) as int value in return statement', 'other\\other.go:3:25', []],
    ]),
  ],
  'go-test/fail-verbose.txt': [
    digest('go test', true, [['packages', 2], ['ok', 1], ['failed', 1]], [
      ['TestAdd', 'calc_test.go:7', ['Add(2, 2) = 4, want 4']],
      ['TestTable/neg', 'calc_test.go:15', ['got -2, want -3']],
    ]),
  ],
  'go-test/fail.txt': [
    digest('go test', true, [['packages', 2], ['ok', 1], ['failed', 1]], [
      ['TestAdd', 'calc_test.go:7', ['Add(2, 2) = 4, want 4']],
      ['TestTable/neg', 'calc_test.go:15', ['got -2, want -3']],
    ]),
  ],
  'go-test/pass-verbose.txt': [
    digest('go test', false, [['packages', 2], ['ok', 2], ['failed', 0]], []),
  ],
  'go-test/pass.txt': [
    digest('go test', false, [['packages', 2], ['ok', 2], ['failed', 0]], []),
  ],
  'cargo-test/compile-error.txt': [
    digest('cargo test', true, [['errors', 2], ['warnings', 0]], [
      ['E0425: cannot find value `undefined_value` in this scope', 'src\\lib.rs:3:27', []],
      ['E0308: mismatched types', 'src\\lib.rs:2:26', []],
    ]),
  ],
  'cargo-test/fail.txt': [
    digest('cargo test', true, [['passed', 1], ['failed', 2], ['ignored', 0]], [
      ['tests::unwraps', 'src\\lib.rs:11:49', ['value must be present']],
      ['tests::adds', 'src\\lib.rs:7:17', ['assertion `left == right` failed', '  left: 4', ' right: 5']],
    ]),
  ],
  'cargo-test/pass.txt': [
    digest('cargo test', false, [['passed', 2], ['failed', 0], ['ignored', 1]], []),
  ],
  'tsc/fail-pretty.txt': [
    digest('tsc', true, [['errors', 3], ['warnings', 0]], [
      ["TS2322: Type 'string' is not assignable to type 'number'.", 'src/a.ts:1:14', []],
      ["TS2551: Property 'toUpperCas' does not exist on type 'string'. Did you mean 'toUpperCase'?", 'src/a.ts:3:15', []],
      ["TS2322: Type 'number' is not assignable to type 'string'.", 'src/b.ts:2:14', []],
    ]),
  ],
  'tsc/fail.txt': [
    digest('tsc', true, [['errors', 3], ['warnings', 0]], [
      ["TS2322: Type 'string' is not assignable to type 'number'.", 'src/a.ts:1:14', []],
      ["TS2551: Property 'toUpperCas' does not exist on type 'string'. Did you mean 'toUpperCase'?", 'src/a.ts:3:15', []],
      ["TS2322: Type 'number' is not assignable to type 'string'.", 'src/b.ts:2:14', []],
    ]),
  ],
  'mypy/fail.txt': [
    digest('mypy', true, [['errors', 3], ['source files checked', 4]], [
      ['Incompatible types in assignment (expression has type "int", variable has type "str")  [assignment]', 'pkg\\a.py:4', []],
      ['Argument 1 to "add" has incompatible type "str"; expected "int"  [arg-type]', 'pkg\\a.py:5', []],
      ['Module has no attribute "missing_name"  [attr-defined]', 'pkg\\b.py:3', []],
    ]),
  ],
  'mypy/pass.txt': [
    digest('mypy', false, [['errors', 0], ['source files checked', 1]], []),
  ],
  'pyright/fail.txt': [
    digest('pyright', true, [['errors', 3], ['warnings', 0]], [
      ['Type "int" is not assignable to declared type "str"', 'c:\\tmp\\rsx\\output-digest-capture\\pyc\\pkg\\a.py:4:15', ['"int" is not assignable to "str" (reportAssignmentType)']],
      ['Argument of type "Literal[\'x\']" cannot be assigned to parameter "a" of type "int" in function "add"', 'c:\\tmp\\rsx\\output-digest-capture\\pyc\\pkg\\a.py:5:5', ['"Literal[\'x\']" is not assignable to "int" (reportArgumentType)']],
      ['"missing_name" is not a known attribute of module "pkg.a" (reportAttributeAccessIssue)', 'c:\\tmp\\rsx\\output-digest-capture\\pyc\\pkg\\b.py:3:20', []],
    ]),
  ],
  'pyright/pass.txt': [
    digest('pyright', false, [['errors', 0], ['warnings', 0]], []),
  ],
  'eslint/fail.txt': [
    digest('eslint', true, [['errors', 3], ['warnings', 2]], [
      ["'unused' is assigned a value but never used (no-unused-vars)", 'C:\\tmp\\rsx\\output-digest-capture\\eslint\\src\\a.js:1:5', []],
      ["Expected '===' and instead saw '==' (eqeqeq)", 'C:\\tmp\\rsx\\output-digest-capture\\eslint\\src\\a.js:3:13', []],
      ["'missingName' is not defined (no-undef)", 'C:\\tmp\\rsx\\output-digest-capture\\eslint\\src\\a.js:3:29', []],
    ]),
  ],
  'eslint/warn-only.txt': [
    digest('eslint', false, [['errors', 0], ['warnings', 1]], []),
  ],
};

for (const [fixture, expected] of Object.entries(EXPECTED)) {
  test(`${fixture} digests to exactly its tools, counts and failures`, () => {
    assert.deepEqual(digestToolOutput(readDigestFixture(fixture)), expected);
  });
}

test('every captured fixture has an exact expectation', () => {
  assert.deepEqual(listDigestFixtures(), Object.keys(EXPECTED).sort());
});

test('tsc output followed by eslint output yields a digest for each, in order', () => {
  const combined = `${readDigestFixture('tsc/fail.txt')}\n${readDigestFixture('eslint/fail.txt')}`;
  assert.deepEqual(digestToolOutput(combined), [...(EXPECTED['tsc/fail.txt'] ?? []), ...(EXPECTED['eslint/fail.txt'] ?? [])]);
});
