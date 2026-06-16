import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BenchmarkFixture } from './types.js';

export function getFixtureManifest(fixtureRoot: string): BenchmarkFixture[] {
  const manifestPath = path.join(fixtureRoot, 'fixtures.json');
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as BenchmarkFixture[];
}
