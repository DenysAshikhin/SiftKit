import fs from 'node:fs';
import path from 'node:path';

/** Files whose line count every tool must agree on, under the line rule in `src/lib/source-lines.ts`. */
export const LINE_COUNT_FIXTURES: { name: string; content: string | Buffer; lines: number; lastLineBlank: boolean }[] = [
  { name: 'lf.txt', content: 'a\nb\n', lines: 2, lastLineBlank: false },
  { name: 'crlf.txt', content: 'a\r\nb\r\n', lines: 2, lastLineBlank: false },
  { name: 'nofinal.txt', content: 'a\nb', lines: 2, lastLineBlank: false },
  { name: 'empty.txt', content: '', lines: 0, lastLineBlank: true },
  { name: 'newline.txt', content: '\n', lines: 1, lastLineBlank: true },
  { name: 'blanklast.txt', content: 'a\n\n', lines: 2, lastLineBlank: true },
  { name: 'lonecr.txt', content: 'a\rb\n', lines: 1, lastLineBlank: false },
  { name: 'utf16.txt', content: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a\nb\nc\n', 'utf16le')]), lines: 3, lastLineBlank: false },
];

/** Writes the fixtures into `<root>/lines` and returns that directory's repository-relative path. */
export function writeLineCountFixtures(root: string): string {
  fs.mkdirSync(path.join(root, 'lines'));
  for (const fixture of LINE_COUNT_FIXTURES) fs.writeFileSync(path.join(root, 'lines', fixture.name), fixture.content);
  return 'lines';
}
