import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import { VaultTab } from '../src/tabs/VaultTab.tsx';
import { noteDetail, vaultNote, vaultTabProps } from './vault-fixture.ts';

test('VaultTab opens on the graph with ribbon, tree, tabs, graph controls, preview panel and status bar', () => {
  const html = renderToStaticMarkup(<VaultTab {...vaultTabProps()} />);
  assert.match(html, /<nav class="v-ribbon">/);
  assert.match(html, /<div class="v-tree-sec">Starred<\/div>/);
  assert.match(html, /<div class="v-tab v-active"><span>◎ Graph view<\/span>/);
  assert.match(html, /<div class="v-tab"><span>Visual Studio Code<\/span>/);
  assert.match(html, /<div class="v-graph-ctl">/);
  assert.match(html, /<input type="checkbox" checked=""\/><span class="v-dot" style="background:#2fbfa0"><\/span>Software<small>1<\/small>/);
  assert.match(html, /1 note · 0 links · click to preview/);
  assert.match(html, /<button type="button" class="v-on">Local graph<\/button>/);
  assert.match(html, /Click a node to preview it here/);
  assert.match(html, /<footer class="v-status">/);
});

test('VaultTab shows the active note with its local graph panel, and search results replace the tree', () => {
  const props = vaultTabProps();
  const html = renderToStaticMarkup(<VaultTab {...props} tabs={{ ...props.tabs, active: 1 }} search="code" searchResult={{ total: 0, hits: [] }} />);
  assert.match(html, /<h1 title="Click to rename">Visual Studio Code<\/h1>/);
  assert.match(html, /Depth<select>/);
  assert.match(html, /<div class="v-summary">0 notes<\/div>/);
  assert.doesNotMatch(html, /v-tree-sec/);
});

test('VaultTab renders the load error alone, plus the toast and graph preview when present', () => {
  assert.equal(renderToStaticMarkup(<VaultTab {...vaultTabProps({ error: 'Assistant is disabled.' })} />), '<div class="vault"><div class="v-empty">Assistant is disabled.</div></div>');
  const note = vaultNote();
  const html = renderToStaticMarkup(<VaultTab {...vaultTabProps({ graphSelection: note.id, details: new Map([[note.id, noteDetail(note)]]), toast: { text: 'Saved.', error: false } })} />);
  assert.match(html, /<div class="v-preview-card">.*<h2>Visual Studio Code<\/h2>.*4 links · updated 1h ago/);
  assert.match(html, /<div class="v-toast">Saved\.<\/div>/);
});
