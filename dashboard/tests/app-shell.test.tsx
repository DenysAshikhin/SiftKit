import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { App } from '../src/App';

test('app renders rail, top bar, and the runs view by default', () => {
  const markup = renderToStaticMarkup(<App />);
  assert.match(markup, /class="rail"/);
  assert.match(markup, /class="top"/);
  assert.match(markup, /SiftKit \//);
});
