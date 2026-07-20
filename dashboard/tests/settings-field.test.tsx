import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SettingsField, shouldInlineHelp } from '../src/settings/SettingsFields';

test('shouldInlineHelp is true only for non-empty help up to 60 chars', () => {
  assert.equal(shouldInlineHelp(undefined), false);
  assert.equal(shouldInlineHelp(''), false);
  assert.equal(shouldInlineHelp('x'.repeat(60)), true);
  assert.equal(shouldInlineHelp('x'.repeat(61)), false);
});

test('short help renders an inline fhint and no popover', () => {
  const markup = renderToStaticMarkup(
    <SettingsField label="X" layout="quarter" helpText="short help"><span>c</span></SettingsField>,
  );
  assert.match(markup, /class="field"/);
  assert.match(markup, /class="fhint"/);
  assert.match(markup, /short help/);
  assert.doesNotMatch(markup, /settings-live-help-popover/);
});

test('long help renders the hover popover and no inline fhint', () => {
  const markup = renderToStaticMarkup(
    <SettingsField label="X" layout="half" helpText={'x'.repeat(61)}><span>c</span></SettingsField>,
  );
  assert.match(markup, /class="field w2"/);
  assert.match(markup, /settings-live-help-popover/);
  assert.doesNotMatch(markup, /class="fhint"/);
});

test('full layout spans w4', () => {
  const markup = renderToStaticMarkup(
    <SettingsField label="X" layout="full"><span>c</span></SettingsField>,
  );
  assert.match(markup, /class="field w4"/);
});
