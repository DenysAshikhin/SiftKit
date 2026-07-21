import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FilterChips } from '../src/components/FilterChips';

const ITEMS = [
  { value: 'all', label: 'All', active: true },
  { value: 'summary', label: 'Summary', active: false },
];

test('FilterChips renders outline pills and marks active', () => {
  const markup = renderToStaticMarkup(<FilterChips items={ITEMS} onToggle={() => {}} />);
  assert.match(markup, /class="chips"/);
  assert.match(markup, /class="chip on"[^>]*>All/);
  assert.match(markup, /class="chip"[^>]*>Summary/);
});

test('FilterChips calls onToggle with the clicked value', () => {
  let picked = '';
  const element = FilterChips({ items: ITEMS, onToggle: (v) => { picked = v; } });
  function walk(node: React.ReactNode): void {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!React.isValidElement(node)) { return; }
    const props = node.props;
    if (props.children === 'Summary' && typeof props.onClick === 'function') { props.onClick(); }
    walk(props.children ?? null);
  }
  walk(element);
  assert.equal(picked, 'summary');
});
