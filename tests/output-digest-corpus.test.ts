import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { parseJsonText } from '../src/lib/json.ts';
import { z } from '../src/lib/zod.ts';
import { digestOutput, digestToolOutput } from '../src/output-digest/digest.ts';

const CORPUS_ROOT = path.join(process.cwd(), 'tests', 'fixtures', 'output-digest-runs', '67e089d0');
const IndexSchema = z.array(z.strictObject({
  file: z.string().min(1),
  task: z.string().min(1),
  turn: z.number().int().positive(),
  command: z.string(),
  exitCode: z.number().int().nullable(),
  class: z.enum(['unfiltered', 'partial', 'filtered']),
  tool: z.enum(['node:test', 'vitest', 'tsc', 'eslint']),
  truncated: z.boolean(),
  strip: z.enum(['none', 'exact', 'structural']),
}));
const ExpectedSchema = z.record(z.string(), z.string().nullable());
const NODE_RESULT_FAILURE = /^✖ .+ \(\d+(?:\.\d+)?ms\)$/mu;
const TSC_ERROR = /^\S+\(\d+,\d+\): error TS\d+/gmu;

const index = parseJsonText(fs.readFileSync(path.join(CORPUS_ROOT, 'index.json'), 'utf8'), IndexSchema);
const expected = parseJsonText(fs.readFileSync(path.join(CORPUS_ROOT, 'expected.json'), 'utf8'), ExpectedSchema);

function readCorpusOutput(file: string): string {
  return fs.readFileSync(path.join(CORPUS_ROOT, file), 'utf8');
}

test('the index, the golden digests, and the files on disk name the same outputs', () => {
  const onDisk = fs.readdirSync(CORPUS_ROOT).filter((file) => file.endsWith('.txt')).sort();
  assert.deepEqual(index.map((entry) => entry.file).sort(), onDisk);
  assert.deepEqual(Object.keys(expected).sort(), onDisk);
});

for (const entry of index) {
  test(`${entry.file} digests exactly as recorded and agrees with its own evidence`, () => {
    const text = readCorpusOutput(entry.file);
    assert.ok(!text.startsWith('Digest of the whole output:'), 'the saved output carries no SiftKit digest');
    assert.equal(digestOutput(text)?.text ?? null, expected[entry.file]);
    const digests = digestToolOutput(text);
    const node = digests.find((digest) => digest.tool === 'node:test');
    if (/^ℹ fail [1-9]/mu.test(text) || NODE_RESULT_FAILURE.test(text)) assert.equal(node?.failed, true, 'a failing node:test line means FAILED');
    const shownTests = [...text.matchAll(/^ℹ tests (\d+)$/gmu)].map((match) => Number(match[1]));
    if (shownTests.length > 0) {
      assert.equal(node?.counts.find((count) => count.label === 'tests')?.value, shownTests.reduce((sum, value) => sum + value, 0));
    }
    const tscErrors = new Set(text.match(TSC_ERROR) ?? []);
    if (tscErrors.size > 0) {
      const tsc = digests.find((digest) => digest.tool === 'tsc');
      assert.ok((tsc?.counts.find((count) => count.label === 'errors')?.value ?? 0) >= tscErrors.size, 'every shown tsc error is counted');
    }
  });
}
