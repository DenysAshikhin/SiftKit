import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToolPolicyMatrix } from '../src/tabs/settings/ToolPolicyMatrix';
import type { DashboardConfig, DashboardOperationModeAllowedTools } from '../src/types';
import { DASHBOARD_CONFIG } from './fixtures';

const ALLOWED: DashboardOperationModeAllowedTools = {
  summary: ['find_text'],
  'read-only': ['find_text', 'repo_rg'],
  full: ['find_text', 'repo_rg', 'web_search'],
};

test('renders a tp-table with mode columns and checkbox cells', () => {
  const markup = renderToStaticMarkup(<ToolPolicyMatrix allowed={ALLOWED} updateSettingsDraft={() => {}} />);
  assert.match(markup, /class="tp-table"/);
  assert.match(markup, /summary/);
  assert.match(markup, /read-only/);
  assert.match(markup, /Text &amp; JSON/);
  assert.match(markup, /class="cb on"/);
  assert.match(markup, /class="cb"/);
});

test('clicking a cell toggles the tool in that mode via updateSettingsDraft', () => {
  const config: DashboardConfig = JSON.parse(JSON.stringify(DASHBOARD_CONFIG));
  config.OperationModeAllowedTools = { summary: [], 'read-only': [], full: [] };
  let applied = false;
  const element = ToolPolicyMatrix({
    allowed: config.OperationModeAllowedTools,
    updateSettingsDraft: (updater) => { updater(config); applied = true; },
  });
  function walk(node: React.ReactNode): boolean {
    if (Array.isArray(node)) { return node.some(walk); }
    if (!React.isValidElement(node)) { return false; }
    const props = node.props;
    if (typeof props.onToggle === 'function') { props.onToggle(); return true; }
    return walk(props.children ?? null);
  }
  const clicked = walk(element);
  assert.ok(clicked);
  assert.ok(applied);
  assert.ok(config.OperationModeAllowedTools.summary.includes('find_text'));
});
