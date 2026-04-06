import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { runEvaluation } from '../dist/eval.js';
import { withTestEnvAndServer } from './_test-helpers.js';

test('runEvaluation runs a fixture manifest and produces scored results', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    const fixtureRoot = path.join(tempRoot, 'fixtures');
    fs.mkdirSync(fixtureRoot, { recursive: true });

    fs.writeFileSync(path.join(fixtureRoot, 'source1.txt'), 'Build completed. All 42 tests passed. No errors found.', 'utf8');
    fs.writeFileSync(path.join(fixtureRoot, 'fixtures.json'), JSON.stringify([
      {
        Name: 'test-fixture',
        File: 'source1.txt',
        Question: 'Did the build pass?',
        Format: 'text',
        PolicyProfile: 'general',
        RequiredTerms: ['42'],
        ForbiddenTerms: ['CRASH'],
      },
    ]), 'utf8');

    const result = await runEvaluation({
      FixtureRoot: fixtureRoot,
    });
    assert.equal(typeof result.Backend, 'string');
    assert.equal(typeof result.Model, 'string');
    assert.equal(typeof result.ResultPath, 'string');
    assert.ok(Array.isArray(result.Results));
    assert.equal(result.Results.length, 1);
    assert.equal(result.Results[0].Name, 'test-fixture');
    assert.equal(typeof result.Results[0].Recall, 'number');
    assert.equal(typeof result.Results[0].Precision, 'number');
    assert.equal(typeof result.Results[0].Faithfulness, 'number');
    assert.equal(typeof result.Results[0].Format, 'number');
    assert.equal(typeof result.Results[0].Compression, 'number');
    assert.equal(typeof result.Results[0].Total, 'number');
  });
});

test('runEvaluation with RealLogPath includes real log results', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    const fixtureRoot = path.join(tempRoot, 'fixtures');
    fs.mkdirSync(fixtureRoot, { recursive: true });
    fs.writeFileSync(path.join(fixtureRoot, 'fixtures.json'), JSON.stringify([]), 'utf8');

    const realLogPath = path.join(tempRoot, 'real.log');
    fs.writeFileSync(realLogPath, 'Real build log content with errors and important info.\n'.repeat(30), 'utf8');

    const result = await runEvaluation({
      FixtureRoot: fixtureRoot,
      RealLogPath: [realLogPath],
    });
    assert.ok(Array.isArray(result.Results));
    assert.equal(result.Results.length, 1);
    assert.match(result.Results[0].Name, /^RealLog:/u);
    assert.equal(result.Results[0].Recall, null);
  });
});

test('runEvaluation with JSON format fixture validates parse', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    const fixtureRoot = path.join(tempRoot, 'fixtures');
    fs.mkdirSync(fixtureRoot, { recursive: true });

    fs.writeFileSync(path.join(fixtureRoot, 'source-json.txt'), '{"status":"ok","tests":42,"failed":0}', 'utf8');
    fs.writeFileSync(path.join(fixtureRoot, 'fixtures.json'), JSON.stringify([
      {
        Name: 'json-fixture',
        File: 'source-json.txt',
        Question: 'Extract test results as JSON',
        Format: 'json',
        PolicyProfile: 'json-extraction',
        RequiredTerms: [],
        ForbiddenTerms: [],
      },
    ]), 'utf8');

    const result = await runEvaluation({
      FixtureRoot: fixtureRoot,
    });
    assert.equal(result.Results.length, 1);
    assert.equal(typeof result.Results[0].Format, 'number');
  });
});

test('runEvaluation skips nonexistent RealLogPath entries', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    const fixtureRoot = path.join(tempRoot, 'fixtures');
    fs.mkdirSync(fixtureRoot, { recursive: true });
    fs.writeFileSync(path.join(fixtureRoot, 'fixtures.json'), JSON.stringify([]), 'utf8');

    const result = await runEvaluation({
      FixtureRoot: fixtureRoot,
      RealLogPath: [path.join(tempRoot, 'nonexistent.log')],
    });
    assert.equal(result.Results.length, 0);
  });
});
