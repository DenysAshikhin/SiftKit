import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { StatusDot, statusTone } from '../src/components/StatusDot';

test('statusTone maps statuses to dot tones', () => {
  assert.equal(statusTone('completed'), 'ok');
  assert.equal(statusTone('failed'), 'bad');
  assert.equal(statusTone('running'), 'run');
  assert.equal(statusTone('anything-else'), 'run');
});

test('StatusDot renders a toned dot and label', () => {
  const markup = renderToStaticMarkup(<StatusDot status="completed" />);
  assert.match(markup, /class="dot ok"/);
  assert.match(markup, /completed/);
});
