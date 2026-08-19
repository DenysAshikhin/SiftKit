import './react-test-environment.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';

import { fireEvent, render, screen } from './react-test-environment.js';
import { PendingImageStrip, removePendingImage } from '../src/components/PendingImageStrip.js';
import type { PendingImage } from '../src/lib/downscale-image.js';

const PNG_A = 'data:image/png;base64,AA==';
const PNG_B = 'data:image/png;base64,AQ==';
const PNG_C = 'data:image/png;base64,Ag==';
const IMAGE_A = { dataUrl: PNG_A, note: null };
const IMAGE_B = { dataUrl: PNG_B, note: 'Resized from 4000×2000 to 22×11' };
const IMAGE_C = { dataUrl: PNG_C, note: null };

function renderStrip(images: PendingImage[]): string {
  return renderToStaticMarkup(<PendingImageStrip images={images} pendingCount={0} onChange={() => undefined} />);
}

test('renders one thumbnail per pending image', () => {
  const html = renderStrip([IMAGE_A, IMAGE_B]);
  assert.equal((html.match(/<img\b/gu) ?? []).length, 2);
});

test('renders the resize note on its matching pending image', () => {
  const html = renderStrip([IMAGE_A, IMAGE_B]);
  assert.match(html, /title="Resized from 4000×2000 to 22×11"/u);
});

test('the remove control removes the right index', () => {
  assert.deepEqual(removePendingImage([IMAGE_A, IMAGE_B, IMAGE_C], 1), [IMAGE_A, IMAGE_C]);
});

test('clicking a remove control reports the remaining images', () => {
  let nextImages: PendingImage[] | null = null;
  render(<PendingImageStrip images={[IMAGE_A, IMAGE_B, IMAGE_C]} pendingCount={0} onChange={(next) => { nextImages = next; }} />);

  fireEvent.click(screen.getByRole('button', { name: 'Remove image 2' }));

  assert.deepEqual(nextImages, [IMAGE_A, IMAGE_C]);
});

test('the remove control renders a multiplication glyph', () => {
  render(<PendingImageStrip images={[IMAGE_A]} pendingCount={0} onChange={() => undefined} />);

  assert.equal(screen.getByRole('button', { name: 'Remove image 1' }).textContent?.trim(), '×');
});

test('the remove control is reachable by keyboard, not hover-only', () => {
  const dom = new JSDOM(renderStrip([IMAGE_A]));
  const button = dom.window.document.querySelector('button[aria-label="Remove image 1"]');
  assert.ok(button instanceof dom.window.HTMLButtonElement);
  button.focus();
  assert.equal(dom.window.document.activeElement, button);
  dom.window.close();
});

test('renders nothing when there are no pending images', () => {
  assert.equal(renderStrip([]), '');
});
