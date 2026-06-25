import fs from 'node:fs';
import path from 'node:path';
import { z } from '../../src/lib/zod.js';
import { parseJsonValueText } from '../../src/lib/json.js';
import { BenchmarkFixtureSchema, type BenchmarkFixture } from './types.js';

export function getFixtureManifest(fixtureRoot: string): BenchmarkFixture[] {
  const manifestPath = path.join(fixtureRoot, 'fixtures.json');
  return z.array(BenchmarkFixtureSchema).parse(parseJsonValueText(fs.readFileSync(manifestPath, 'utf8')));
}
