import { afterEach, beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';

import { getDefaultConfigObject } from '../../src/config/defaults.ts';
import { useSettingsController } from '../src/hooks/useSettingsController.ts';
import { act, renderHook, waitFor } from './react-test-environment.ts';
import { GLM_PROFILE } from './fixtures.ts';

const originalFetch = globalThis.fetch;
let profileRequests = 0;

beforeEach(() => {
  profileRequests = 0;
  const config = getDefaultConfigObject();
  const preset = config.Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default model preset is missing');
  Object.assign(preset, { ModelPath: 'D:\\models\\GLM-5.3-Flash-3.00bpw-hq', Reasoning: 'off', NgramRam: true });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith('/config')) return Response.json(config);
    if (url === '/dashboard/model-profile') {
      profileRequests += 1;
      return Response.json({ profile: GLM_PROFILE });
    }
    return new Response('not found', { status: 404 });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function renderController() {
  return renderHook(() => useSettingsController({
    enqueueToast() {},
    requestDashboardDataRefresh() {},
    tab: 'settings',
    webSearchUsage: null,
    webSearchQuota: null,
    onSwitchTab() {},
  }));
}

test('the selected preset is identified once and the profile is applied to the draft', async () => {
  const { result } = renderController();

  await waitFor(() => assert.equal(result.current.tabProps.modelProfileStatus.state, 'identified'));
  await waitFor(() => assert.equal(result.current.selectedModelPreset?.Reasoning, 'on'));
  assert.equal(result.current.selectedModelPreset?.NgramRam, false);
  assert.equal(result.current.settingsDirty, true);
  assert.equal(profileRequests, 1);
});

test('re-locking a preset re-applies the identified profile without asking the server again', async () => {
  const { result } = renderController();
  await waitFor(() => assert.equal(result.current.selectedModelPreset?.Reasoning, 'on'));

  act(() => result.current.tabProps.modelPresetActions.setBoolean('UnlockAllSettings', true));
  act(() => result.current.tabProps.modelPresetActions.setReasoning('off'));
  assert.equal(result.current.selectedModelPreset?.Reasoning, 'off');
  act(() => result.current.tabProps.modelPresetActions.setBoolean('UnlockAllSettings', false));

  await waitFor(() => assert.equal(result.current.selectedModelPreset?.Reasoning, 'on'));
  assert.equal(profileRequests, 1);
});
