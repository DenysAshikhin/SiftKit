import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Rail, RAIL_ITEMS } from '../src/components/Rail';

test('rail lists all five sections with labels', () => {
  const markup = renderToStaticMarkup(
    <Rail activeTab="runs" serverHealthy onSelectTab={() => {}} />,
  );
  for (const label of ['Logs', 'Metrics', 'Bench', 'Chat', 'Settings']) {
    assert.match(markup, new RegExp(label));
  }
  assert.equal(RAIL_ITEMS.length, 5);
});

test('rail marks the active tab and calls back on click', () => {
  let picked = '';
  const element = Rail({ activeTab: 'settings', serverHealthy: false, onSelectTab: (t) => { picked = t; } });
  const markup = renderToStaticMarkup(element);
  assert.match(markup, /class="[^"]*on[^"]*"[^>]*>[\s\S]*?Settings/);
  assert.match(markup, /pulse offline/);

  function walk(node: React.ReactNode): void {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!React.isValidElement(node)) { return; }
    const props = node.props;
    if (props.title === 'Logs' && typeof props.onClick === 'function') { props.onClick(); }
    walk(props.children ?? null);
  }
  walk(element);
  assert.equal(picked, 'runs');
});
