import React from 'react';

import type { ModelProfile } from '@siftkit/contracts';
import { getProfileIgnoredFields } from '../../../../src/inference-presets/preset-compatibility.ts';
import type { ModelPresetSettingsActions } from '../../settings-action-groups.ts';
import type { ModelProfileStatus } from '../../settings-flow.ts';
import type { DashboardModelRuntimePreset } from '../../types.ts';

const CAPABILITY_LABELS = [
  ['moe', 'MoE'], ['recurrent', 'recurrent'], ['mtp', 'MTP'], ['vision', 'vision'], ['ngram', 'n-gram'], ['mla', 'MLA'],
] as const;

function describeSampling(profile: ModelProfile): string {
  const { temperature, topP, topK } = profile.sampling;
  return [
    temperature === null ? null : `temperature ${temperature}`,
    topP === null ? null : `top_p ${topP}`,
    topK === null ? null : `top_k ${topK}`,
  ].filter((part) => part !== null).join(', ');
}

export function ModelProfileBanner({ status, preset, modelPresetActions }: {
  status: ModelProfileStatus;
  preset: DashboardModelRuntimePreset;
  modelPresetActions: ModelPresetSettingsActions;
}) {
  switch (status.state) {
    case 'no-path':
      return null;
    case 'identifying':
      return <div className="mp-profile" role="status">Identifying the model…</div>;
    case 'unidentified':
      return (
        <div className="mp-profile warn" role="status">
          Could not identify the model: {status.error}. Every setting stays editable.
        </div>
      );
    case 'identified': {
      const { profile } = status;
      const ignored = getProfileIgnoredFields(profile).length;
      const capabilities = CAPABILITY_LABELS.filter(([key]) => profile[key]).map(([, label]) => label).join(' · ');
      const sampling = describeSampling(profile);
      const settingsNoun = ignored === 1 ? '1 setting doesn\'t' : `${ignored} settings don't`;
      return (
        <div className="mp-profile" role="status">
          <div><span className="ok">✓</span> Auto-identified <strong>{profile.name}</strong> <span className="dim">({profile.architecture})</span></div>
          <div className="dim">{capabilities || 'No MoE, recurrent, MTP, vision, n-gram, or MLA layers'}</div>
          <div>
            {preset.UnlockAllSettings
              ? `All settings unlocked; ${settingsNoun} apply to this model.`
              : `${settingsNoun} apply and are grayed out.`}
          </div>
          {sampling ? (
            <div>
              Recommended sampling: {sampling}{' '}
              <button type="button" className="ghost-btn" onClick={() => modelPresetActions.applyRecommendedSampling(profile)}>Apply</button>
            </div>
          ) : null}
          <label className="settings-live-toggle-control">
            <input
              type="checkbox"
              aria-label="Unlock all settings"
              checked={preset.UnlockAllSettings}
              onChange={(event) => modelPresetActions.setBoolean('UnlockAllSettings', event.target.checked)}
            />
            <span>Unlock all settings</span>
          </label>
        </div>
      );
    }
  }
}
