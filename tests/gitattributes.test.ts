import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('repo root pins line endings to LF via .gitattributes', () => {
  assert.equal(fs.existsSync('.gitattributes'), true);
  const contents = fs.readFileSync('.gitattributes', 'utf8');
  assert.match(contents, /^\*\s+text=auto\s+eol=lf\s*$/mu);
});
