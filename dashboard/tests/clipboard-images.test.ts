import test from 'node:test';
import assert from 'node:assert/strict';

import { extractClipboardImageFiles } from '../src/lib/clipboard-images';

type ClipboardStub = { items: { kind: string; type: string; getAsFile(): File | null }[] };

const PNG = new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' });

function clipboard(entries: { type: string; file: File | null }[]): ClipboardStub {
  return {
    items: entries.map((entry) => ({ kind: 'file', type: entry.type, getAsFile: () => entry.file })),
  };
}

test('extracts image files from a clipboard payload', () => {
  assert.deepEqual(extractClipboardImageFiles(clipboard([{ type: 'image/png', file: PNG }])), [PNG]);
});

test('ignores text entries so a plain text paste is untouched', () => {
  assert.deepEqual(extractClipboardImageFiles(clipboard([{ type: 'text/plain', file: null }])), []);
});

test('ignores image entries that expose no file', () => {
  assert.deepEqual(extractClipboardImageFiles(clipboard([{ type: 'image/png', file: null }])), []);
});

test('returns nothing when there is no clipboard data', () => {
  assert.deepEqual(extractClipboardImageFiles(null), []);
});