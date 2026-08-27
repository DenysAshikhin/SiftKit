import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ToolActivityRow } from '../src/components/ToolActivityRow';
import type { ToolActivityGroup } from '../src/lib/tool-activity-ring';

function group(state: ToolActivityGroup['state']): ToolActivityGroup {
  return {
    key: '1:read',
    turn: 1,
    activityKind: 'read',
    subjects: [{ kind: 'file', value: 'ChatTab.tsx' }],
    state,
    messages: [],
  };
}

test('activity row is neutral text without status icons or diagnostics', () => {
  const markup = renderToStaticMarkup(<ToolActivityRow group={group('active')} />);
  assert.match(markup, /tool-activity-row tool-activity-neutral/u);
  assert.match(markup, /Reading file ChatTab\.tsx…/u);
  assert.doesNotMatch(markup, /✓|tok|command:|details/u);
});

test('failed activity row alone receives subtle failure styling', () => {
  const markup = renderToStaticMarkup(<ToolActivityRow group={group('failed')} />);
  assert.match(markup, /tool-activity-failed/u);
  assert.match(markup, /failed/u);
});
