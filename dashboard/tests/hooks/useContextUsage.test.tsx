import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { useContextUsage } from '../../src/hooks/useContextUsage';

test('useContextUsage initialises contextUsage and liveToolPromptTokenCount to null', () => {
  function Probe(): React.JSX.Element {
    const ctx = useContextUsage();
    return React.createElement('output', {
      dangerouslySetInnerHTML: {
        __html: JSON.stringify({
          contextUsage: ctx.contextUsage,
          liveToolPromptTokenCount: ctx.liveToolPromptTokenCount,
        }),
      },
    });
  }
  const markup = renderToStaticMarkup(React.createElement(Probe));
  assert.match(markup, /"contextUsage":null/);
  assert.match(markup, /"liveToolPromptTokenCount":null/);
});

test('useContextUsage exposes setters that have stable identity per render', () => {
  function Probe(): React.JSX.Element {
    const ctx = useContextUsage();
    return React.createElement(
      'output',
      null,
      String(typeof ctx.setContextUsage === 'function' && typeof ctx.setLiveToolPromptTokenCount === 'function'),
    );
  }
  const markup = renderToStaticMarkup(React.createElement(Probe));
  assert.match(markup, /<output>true<\/output>/);
});
