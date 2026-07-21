import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TopBar } from '../src/components/TopBar';

test('top bar renders breadcrumb and action slot', () => {
  const markup = renderToStaticMarkup(
    <TopBar sectionTitle="Logs" actions={<button>Refresh</button>} />,
  );
  assert.match(markup, /SiftKit \//);
  assert.match(markup, /Logs/);
  assert.match(markup, /Refresh/);
});
