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

test('repro-fixture60-malformed-json writes chunk artifacts and stops on malformed chunk payload', async () => {
  await withTempEnv(async (tempRoot) => {
    let chunkResponseCount = 0;
    await withStubServer(async () => {
      const fixtureRoot = path.join(tempRoot, 'bench-fixtures');
      const outputRoot = path.join(tempRoot, 'fixture60-repro-output');
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

      let stderrText = '';
      const result = await runFixture60MalformedJsonRepro([
        '--fixture-index', '1',
        '--output-root', outputRoot,
      ], {
        fixtureRoot,
        stderr: { write: (text) => { stderrText += String(text); return true; } },
      });

      assert.equal(result.exitCode, 1);
      const artifact = JSON.parse(fs.readFileSync(path.join(outputRoot, 'manifest.json'), 'utf8'));
      assert.equal(artifact.ok, false);
      assert.equal(artifact.chunkCount, 3);
      assert.equal(artifact.malformedChunk.chunkPath, '2/3');
      assert.match(artifact.malformedChunk.error, /Provider returned an invalid SiftKit decision payload/u);
      assert.match(stderrText, /Provider returned an invalid SiftKit decision payload/u);

      const firstChunkPrompt = fs.readFileSync(
        path.join(outputRoot, 'fixtures', 'fixture-01', 'chunks', 'chunk-01', 'prompt.txt'),
        'utf8',
      );
      const secondChunkResponse = fs.readFileSync(
        path.join(outputRoot, 'fixtures', 'fixture-01', 'chunks', 'chunk-02', 'response.txt'),
        'utf8',
      );
      assert.match(firstChunkPrompt, /Chunk path: 1\/3/u);
      assert.equal(secondChunkResponse.endsWith('"output":"broken'), true);
      assert.equal(artifact.chunks.length, 2);
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
        if (chunkResponseCount === 2) {
          return '{"classification":"summary","raw_review_required":false,"output":"broken';
        }

        return JSON.stringify({
          classification: 'summary',
          raw_review_required: false,
          output: `chunk ${chunkResponseCount} summary`,
        });
      },
    });
  });
});
