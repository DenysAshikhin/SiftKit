import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const DASHBOARD_SOURCE_FILES = [
  'dashboard/src/hooks/useSettingsController.ts',
  'dashboard/src/tabs/SettingsTab.tsx',
  'dashboard/src/tabs/settings/ToolPolicyMatrix.tsx',
  'dashboard/src/tabs/settings/PresetsSection.tsx',
  'dashboard/src/tabs/settings/ModelPresetsSection.tsx',
];

function readSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(relativePath), 'utf8');
}

test('settings controller exposes section-scoped named action objects', () => {
  const controllerSource = readSource('dashboard/src/hooks/useSettingsController.ts');

  for (const actionObject of [
    'generalActions',
    'toolPolicyActions',
    'presetActions',
    'interactiveActions',
    'webSearchActions',
    'modelPresetActions',
  ]) {
    assert.match(controllerSource, new RegExp(`\\b${actionObject}\\b`, 'u'));
  }

  assert.equal(
    controllerSource.match(/setDashboardConfig\(\(previous\) =>/gu)?.length,
    1,
  );
});

test('settings component boundaries contain no domain updater functions', () => {
  const source = DASHBOARD_SOURCE_FILES.map(readSource).join('\n');

  assert.doesNotMatch(
    source,
    /updateSettingsDraft|updatePresetDraft|updateModelPresetDraft|DashboardPresetDraftEditor|updateActiveModelPreset/u,
  );
  assert.doesNotMatch(source, /updater:\s*\(/u);
  assert.match(source, /generalActions/u);
  assert.match(source, /toolPolicyActions/u);
  assert.match(source, /presetActions/u);
  assert.match(source, /interactiveActions/u);
  assert.match(source, /webSearchActions/u);
  assert.match(source, /modelPresetActions/u);
});
