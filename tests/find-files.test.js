const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { findFiles } = require('../dist/find-files.js');

test('findFiles returns matching files in a directory tree', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-findfiles-'));
  try {
    fs.mkdirSync(path.join(tempRoot, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'readme.md'), 'hello', 'utf8');
    fs.writeFileSync(path.join(tempRoot, 'index.js'), 'code', 'utf8');
    fs.writeFileSync(path.join(tempRoot, 'sub', 'util.js'), 'util', 'utf8');
    fs.writeFileSync(path.join(tempRoot, 'sub', 'data.txt'), 'data', 'utf8');

    const results = findFiles(['*.js'], tempRoot);
    assert.equal(results.length, 2);
    assert.ok(results.some((r) => r.Name === 'index.js'));
    assert.ok(results.some((r) => r.Name === 'util.js'));
    assert.ok(results.every((r) => r.FullPath.startsWith(tempRoot)));
    assert.ok(results.every((r) => typeof r.RelativePath === 'string' && r.RelativePath.length > 0));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('findFiles supports wildcard ? in patterns', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-findfiles-q-'));
  try {
    fs.writeFileSync(path.join(tempRoot, 'a1.txt'), 'a', 'utf8');
    fs.writeFileSync(path.join(tempRoot, 'a2.txt'), 'b', 'utf8');
    fs.writeFileSync(path.join(tempRoot, 'abc.txt'), 'c', 'utf8');

    const results = findFiles(['a?.txt'], tempRoot);
    assert.equal(results.length, 2);
    assert.ok(results.some((r) => r.Name === 'a1.txt'));
    assert.ok(results.some((r) => r.Name === 'a2.txt'));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('findFiles returns empty array for no matches', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-findfiles-empty-'));
  try {
    fs.writeFileSync(path.join(tempRoot, 'hello.txt'), 'hi', 'utf8');
    const results = findFiles(['*.py'], tempRoot);
    assert.equal(results.length, 0);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('findFiles supports multiple patterns', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-findfiles-multi-'));
  try {
    fs.writeFileSync(path.join(tempRoot, 'a.js'), 'a', 'utf8');
    fs.writeFileSync(path.join(tempRoot, 'b.ts'), 'b', 'utf8');
    fs.writeFileSync(path.join(tempRoot, 'c.py'), 'c', 'utf8');

    const results = findFiles(['*.js', '*.ts'], tempRoot);
    assert.equal(results.length, 2);
    assert.ok(results.some((r) => r.Name === 'a.js'));
    assert.ok(results.some((r) => r.Name === 'b.ts'));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
