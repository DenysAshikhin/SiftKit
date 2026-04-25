// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  fs,
  path,
  runFixture60MalformedJsonRepro,
  withTempEnv,
  withStubServer,
} = require('./_runtime-helpers.js');
const {
  STABLE_CHUNK_BUDGET_METRICS,
  saveFixture60ChunkingConfig,
} = require('./helpers/runtime-benchmark-repro.js');

test('repro-fixture60-malformed-json can run a fixture range and stop on a later malformed fixture', async () => {
  await withTempEnv(async (tempRoot) => {
    let fixture2ChunkResponses = 0;
    await withStubServer(async () => {
      const fixtureRoot = path.join(tempRoot, 'bench-fixtures');
      const outputRoot = path.join(tempRoot, 'fixture60-repro-range-output');
      fs.mkdirSync(fixtureRoot, { recursive: true });
      fs.writeFileSync(path.join(fixtureRoot, 'case1.txt'), 'A'.repeat(11_000), 'utf8');
      fs.writeFileSync(path.join(fixtureRoot, 'case2.txt'), 'B'.repeat(11_000), 'utf8');
      fs.writeFileSync(path.join(fixtureRoot, 'fixtures.json'), JSON.stringify([
        {
          Name: 'fixture-1',
          File: 'case1.txt',
          Question: 'fixture 1 question',
          Format: 'text',
          PolicyProfile: 'general',
        },
        {
          Name: 'fixture-2',
          File: 'case2.txt',
          Question: 'fixture 2 question',
          Format: 'text',
          PolicyProfile: 'general',
        },
      ], null, 2), 'utf8');

      await saveFixture60ChunkingConfig();

      const result = await runFixture60MalformedJsonRepro([
        '--fixture-start-index', '1',
        '--fixture-end-index', '2',
        '--output-root', outputRoot,
      ], {
        fixtureRoot,
      });

      assert.equal(result.exitCode, 1);
      const artifact = JSON.parse(fs.readFileSync(path.join(outputRoot, 'manifest.json'), 'utf8'));
      assert.equal(artifact.fixtureCount, 2);
      assert.equal(artifact.malformedFixture.fixtureIndex, 2);
      assert.equal(artifact.fixtures.length, 2);
      assert.equal(artifact.fixtures[0].ok, true);
      assert.equal(artifact.fixtures[1].malformedChunk.chunkPath, '2/3');
      assert.match(
        fs.readFileSync(path.join(outputRoot, 'fixtures', 'fixture-01', 'chunks', 'chunk-03', 'response.txt'), 'utf8'),
        /fixture 1 chunk 3/u,
      );
    }, {
      metrics: STABLE_CHUNK_BUDGET_METRICS,
      assistantContent(promptText) {
        if (!/<<<BEGIN_LITERAL_INPUT_SLICE>>>/u.test(promptText)) {
          return JSON.stringify({
            classification: 'summary',
            raw_review_required: false,
            output: 'merge summary',
          });
        }

        if (/fixture 2 question/u.test(promptText)) {
          fixture2ChunkResponses += 1;
          if (fixture2ChunkResponses === 2) {
            return '{"classification":"summary","raw_review_required":false,"output":"broken';
          }

          return JSON.stringify({
            classification: 'summary',
            raw_review_required: false,
            output: `fixture 2 chunk ${fixture2ChunkResponses}`,
          });
        }

        const match = /Chunk path: (\d+\/\d+)/u.exec(promptText);
        return JSON.stringify({
          classification: 'summary',
          raw_review_required: false,
          output: `fixture 1 chunk ${match ? match[1].split('/')[0] : 'x'}`,
        });
      },
    });
  });
});
