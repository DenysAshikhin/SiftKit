// @ts-nocheck -- runtime-style tests against dist exports
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readSummaryInput } = require('../dist/summary.js');

function toUtf16BeBuffer(text, withBom = true) {
  const le = Buffer.from(text, 'utf16le');
  const be = Buffer.alloc(le.length);
  for (let index = 0; index < le.length - 1; index += 2) {
    be[index] = le[index + 1];
    be[index + 1] = le[index];
  }
  return withBom ? Buffer.concat([Buffer.from([0xfe, 0xff]), be]) : be;
}

test('readSummaryInput reads UTF-8 file input unchanged', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-encoding-'));
  try {
    const filePath = path.join(tempDir, 'utf8.txt');
    fs.writeFileSync(filePath, 'alpha\nbeta\n', 'utf8');
    const result = readSummaryInput({ file: filePath });
    assert.equal(result, 'alpha\nbeta');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('readSummaryInput decodes UTF-16LE file with BOM', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-encoding-'));
  try {
    const filePath = path.join(tempDir, 'utf16le-bom.txt');
    const payload = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('managed session started\n', 'utf16le'),
    ]);
    fs.writeFileSync(filePath, payload);
    const result = readSummaryInput({ file: filePath });
    assert.equal(result, 'managed session started');
    assert.equal(result.includes('\u0000'), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('readSummaryInput decodes UTF-16BE file with BOM', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-encoding-'));
  try {
    const filePath = path.join(tempDir, 'utf16be-bom.txt');
    fs.writeFileSync(filePath, toUtf16BeBuffer('runner_state_history\n'));
    const result = readSummaryInput({ file: filePath });
    assert.equal(result, 'runner_state_history');
    assert.equal(result.includes('\u0000'), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('readSummaryInput detects BOM-less UTF-16LE file', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-encoding-'));
  try {
    const filePath = path.join(tempDir, 'utf16le-no-bom.txt');
    fs.writeFileSync(filePath, Buffer.from('runner_logs_window\n', 'utf16le'));
    const result = readSummaryInput({ file: filePath });
    assert.equal(result, 'runner_logs_window');
    assert.equal(result.includes('\u0000'), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('readSummaryInput detects BOM-less UTF-16BE file', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-encoding-'));
  try {
    const filePath = path.join(tempDir, 'utf16be-no-bom.txt');
    fs.writeFileSync(filePath, toUtf16BeBuffer('latest_runner_manage_run\n', false));
    const result = readSummaryInput({ file: filePath });
    assert.equal(result, 'latest_runner_manage_run');
    assert.equal(result.includes('\u0000'), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('readSummaryInput decodes UTF-16 stdin buffers', () => {
  const leBuffer = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from('state transition\n', 'utf16le'),
  ]);
  const beBuffer = toUtf16BeBuffer('bridge connected\n');

  const le = readSummaryInput({ stdinText: leBuffer });
  const be = readSummaryInput({ stdinText: beBuffer });

  assert.equal(le, 'state transition');
  assert.equal(be, 'bridge connected');
});

test('readSummaryInput keeps ambiguous binary-like buffers as UTF-8 fallback', () => {
  const binaryLike = Buffer.from([0x61, 0x00, 0x62, 0x00, 0xff, 0xff, 0x63, 0x00, 0x00, 0x64]);
  const result = readSummaryInput({ stdinText: binaryLike });
  assert.equal(typeof result, 'string');
  assert.equal(result.includes('\u0000'), true);
});
