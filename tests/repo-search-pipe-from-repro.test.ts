import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';

const SegmentSchema = z.object({ commandToken: z.string(), text: z.string() });
const SafetySchema = z.object({ safe: z.boolean(), reason: z.string().nullable() });
const PipeSafetyReportSchema = z.object({
  reproduced: z.boolean(),
  safety: SafetySchema,
  directRgParsed: z.boolean(),
  segments: z.array(SegmentSchema),
});
const AuditCommandReportSchema = PipeSafetyReportSchema.extend({
  fixture: z.string(),
  directRgSegments: z.array(SegmentSchema),
  legacyFromSplit: z.boolean(),
  parserMismatch: z.boolean(),
  pipeEvents: z.array(z.object({ inSingle: z.boolean(), inDouble: z.boolean(), split: z.boolean() })),
});

test('repro-repo-search-pipe-from recreates from pipe safety rejection', () => {
  const scriptPath = path.resolve(process.cwd(), 'bench', 'repro', 'repro-repo-search-pipe-from.ts');
  const result = spawnSync(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', scriptPath, '--json'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      windowsHide: true,
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = PipeSafetyReportSchema.parse(JSON.parse(result.stdout));

  assert.equal(report.reproduced, true);
  assert.equal(report.safety.safe, false);
  assert.equal(report.safety.reason, "command 'from' is not in the allow-list");
  assert.equal(report.directRgParsed, false);
  assert.deepEqual(report.segments.map((segment) => segment.commandToken), ['rg', 'from']);
});

test('repro-repo-search-pipe-from recreates saved audit command splitting', () => {
  const scriptPath = path.resolve(process.cwd(), 'bench', 'repro', 'repro-repo-search-pipe-from.ts');
  const result = spawnSync(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', scriptPath, '--fixture', 'audit-command-4', '--json'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      windowsHide: true,
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = AuditCommandReportSchema.parse(JSON.parse(result.stdout));

  assert.equal(report.fixture, 'audit-command-4');
  assert.equal(report.safety.safe, true);
  assert.equal(report.directRgParsed, true);
  assert.equal(report.legacyFromSplit, true);
  assert.equal(report.parserMismatch, true);
  assert.deepEqual(report.segments.map((segment) => segment.commandToken), ['rg', 'from']);
  assert.deepEqual(report.directRgSegments.map((segment) => segment.commandToken), ['rg']);
  assert.equal(report.pipeEvents.some((event) => event.split && !event.inSingle && !event.inDouble), true);
});
