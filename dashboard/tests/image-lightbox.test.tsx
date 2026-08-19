import './react-test-environment.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import { ImageLightbox } from '../src/components/ImageLightbox';
import { fireEvent, render, screen } from './react-test-environment.js';

const PNG = 'data:image/png;base64,AA==';

test('renders the image in a modal dialog', () => {
  render(<ImageLightbox src={PNG} alt="Attachment 1" onClose={() => undefined} />);
  const dialog = screen.getByRole('dialog');
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  assert.equal(screen.getByAltText('Attachment 1').getAttribute('src'), PNG);
});

test('closes on the close button, the backdrop, and Escape', () => {
  let closed = 0;
  const view = render(<ImageLightbox src={PNG} alt="Attachment 1" onClose={() => { closed += 1; }} />);

  fireEvent.click(screen.getByLabelText('Close image'));
  assert.equal(closed, 1);

  fireEvent.click(screen.getByRole('dialog'));
  assert.equal(closed, 2);

  fireEvent.keyDown(window, { key: 'Escape' });
  assert.equal(closed, 3);
  view.unmount();
});

test('a click on the image itself does not close the lightbox', () => {
  let closed = 0;
  render(<ImageLightbox src={PNG} alt="Attachment 1" onClose={() => { closed += 1; }} />);
  fireEvent.click(screen.getByAltText('Attachment 1'));
  assert.equal(closed, 0);
});
