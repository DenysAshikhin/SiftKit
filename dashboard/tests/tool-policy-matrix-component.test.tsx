import { test } from 'vitest';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToolPolicyMatrix } from '../src/tabs/settings/ToolPolicyMatrix.tsx';
import type { ToolPolicySettingsActions } from '../src/settings-action-groups.ts';
import type { DashboardOperationModeAllowedTools } from '../src/types.ts';
import { TOOL_POLICY_ACTIONS } from './fixtures.ts';

const ALLOWED: DashboardOperationModeAllowedTools = {
  summary: ['find_text'],
  'read-only': ['find_text', 'grep'],
  full: ['find_text', 'grep', 'web_search'],
};

test('renders a tp-table with mode columns and checkbox cells', () => {
  const markup = renderToStaticMarkup(
    <ToolPolicyMatrix allowed={ALLOWED} toolPolicyActions={TOOL_POLICY_ACTIONS} />,
  );
  assert.match(markup, /class="tp-table"/);
  assert.match(markup, /summary/);
  assert.match(markup, /read-only/);
  assert.match(markup, /Text &amp; JSON/);
  assert.match(markup, /class="cb on"/);
  assert.match(markup, /class="cb"/);
});

test('matrix cells receive the typed tool-policy action object', () => {
  const actions: ToolPolicySettingsActions = {
    setToolEnabled() {},
  };
  const element = ToolPolicyMatrix({
    allowed: { summary: [], 'read-only': [], full: [] },
    toolPolicyActions: actions,
  });
  function walk(node: React.ReactNode): boolean {
    if (Array.isArray(node)) { return node.some(walk); }
    if (!React.isValidElement<{
      toolPolicyActions?: ToolPolicySettingsActions;
      children?: React.ReactNode;
    }>(node)) {
      return false;
    }
    const props = node.props;
    if (props.toolPolicyActions) {
      assert.equal(props.toolPolicyActions, actions);
      return true;
    }
    return walk(props.children ?? null);
  }
  assert.equal(walk(element), true);
});
