import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describeFileLines, formatFileLines, formatLineCount, READ_MAX_BYTES, splitSourceLines } from '../src/lib/source-lines.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

test('splitSourceLines ends the last line at a trailing newline and gives an empty text no lines', () => {
  assert.deepEqual(splitSourceLines(''), []);
  assert.deepEqual(splitSourceLines('\n'), ['']);
  assert.deepEqual(splitSourceLines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(splitSourceLines('a\nb'), ['a', 'b']);
  assert.deepEqual(splitSourceLines('a\n\n'), ['a', '']);
  assert.deepEqual(splitSourceLines('a\rb\n'), ['a\rb']);
});

test('describeFileLines decodes like read and classifies binary and oversized files', () => {
  const root = createManagedTempDir('siftkit-source-lines-');
  const write = (name: string, content: string | Buffer) => {
    fs.writeFileSync(path.join(root, name), content);
    return path.join(root, name);
  };
  assert.deepEqual(describeFileLines(write('crlf.txt', 'a\r\nb\r\n')), { kind: 'text', lines: ['a', 'b'] });
  assert.deepEqual(describeFileLines(write('empty.txt', '')), { kind: 'text', lines: [] });
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a\nb\nc\n', 'utf16le')]);
  assert.deepEqual(describeFileLines(write('utf16.txt', utf16)), { kind: 'text', lines: ['a', 'b', 'c'] });
  assert.deepEqual(describeFileLines(write('bin.dat', Buffer.from([0x89, 0x50, 0x00, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]))), { kind: 'binary' });
  const big = write('big.log', Buffer.alloc(READ_MAX_BYTES + 1, 0x61));
  assert.deepEqual(describeFileLines(big), { kind: 'too_large', bytes: READ_MAX_BYTES + 1 });
});

test('file line wording is shared by every tool', () => {
  assert.equal(formatLineCount(0), '0 lines');
  assert.equal(formatLineCount(1), '1 line');
  assert.equal(formatLineCount(2), '2 lines');
  assert.equal(formatFileLines({ kind: 'text', lines: ['a'] }), '(1 line)');
  assert.equal(formatFileLines({ kind: 'binary' }), '(binary)');
  assert.equal(formatFileLines({ kind: 'too_large', bytes: 2_400_000 }), '(2,400,000 bytes; too large to read)');
});
