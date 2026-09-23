import assert from 'node:assert/strict';
import test from 'node:test';

import { Exl3ModelCapabilities } from '../../src/inference-presets/exl3-model-capabilities.js';


test('Exl3ModelCapabilities reports an executable that cannot run the package probe', () => {
  assert.equal(new Exl3ModelCapabilities().inspectDeviceResidentPastIds(process.execPath), 'interpreter-unavailable');
});
