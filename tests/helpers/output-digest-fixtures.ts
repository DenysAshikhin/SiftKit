import fs from 'node:fs';
import path from 'node:path';

const FIXTURE_ROOT = path.join(process.cwd(), 'tests', 'fixtures', 'output-digest');

/** The absolute path of one captured console output, named `<tool>/<case>.txt`. */
export function digestFixturePath(name: string): string {
  return path.join(FIXTURE_ROOT, name);
}

export function readDigestFixture(name: string): string {
  return fs.readFileSync(digestFixturePath(name), 'utf8');
}

/** Every captured output as `<tool>/<case>.txt`, sorted; the README beside them is not one. */
export function listDigestFixtures(): string[] {
  return fs.readdirSync(FIXTURE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => fs.readdirSync(path.join(FIXTURE_ROOT, entry.name)).map((file) => `${entry.name}/${file}`))
    .sort();
}
