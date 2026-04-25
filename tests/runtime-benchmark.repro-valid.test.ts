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

test('repro-fixture60-malformed-json writes a completed manifest for valid chunk responses', async () => {
  await withTempEnv(async (tempRoot) => {
    let chunkResponseCount = 0;
    await withStubServer(async () => {
      const fixtureRoot = path.join(tempRoot, 'bench-fixtures');
      const outputRoot = path.join(tempRoot, 'fixture60-repro-success-output');
      fs.mkdirSync(fixtureRoot, { recursive: true });
      fs.writeFileSync(path.join(fixtureRoot, 'case1.txt'), 'A'.repeat(11_000), 'utf8');
      fs.writeFileSync(path.join(fixtureRoot, 'fixtures.json'), JSON.stringify([
        {
          Name: 'fixture60-repro-case',
          File: 'case1.txt',
          Question: 'summarize this',
          Format: 'text',
          PolicyProfile: 'general',
        },
      ], null, 2), 'utf8');

      await saveFixture60ChunkingConfig();

      const result = await runFixture60MalformedJsonRepro([
        '--fixture-index', '1',
        '--output-root', outputRoot,
      ], {
        fixtureRoot,
      });

      assert.equal(result.exitCode, 0);
      const artifact = JSON.parse(fs.readFileSync(path.join(outputRoot, 'manifest.json'), 'utf8'));
      assert.equal(artifact.ok, true);
      assert.equal(artifact.malformedChunk, null);
      assert.equal(artifact.chunkCount, 3);
      assert.equal(artifact.chunks.length, 3);
      assert.equal(artifact.chunks.every((chunk) => chunk.parsed === true), true);
      assert.match(
        fs.readFileSync(path.join(outputRoot, 'fixtures', 'fixture-01', 'chunks', 'chunk-03', 'response.txt'), 'utf8'),
        /chunk 3 summary/u,
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

        chunkResponseCount += 1;
        return JSON.stringify({
          classification: 'summary',
          raw_review_required: false,
          output: `chunk ${chunkResponseCount} summary`,
        });
      },
    });
  });
});
