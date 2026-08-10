import assert from 'node:assert/strict';
import test from 'node:test';

import { AssistantConfigSchema } from '@siftkit/contracts';
import { DEFAULT_ASSISTANT_CONFIG } from '../src/config/defaults.js';
import { normalizeAssistantConfig } from '../src/config/normalization.js';
import { getDefaultConfig, readConfig, writeConfig } from '../src/status-server/config-store.js';
import { getRuntimeDatabase } from '../src/state/runtime-db.js';
import { path, withTempEnv } from './_runtime-helpers.js';

test('AssistantConfigSchema is strict and the documented defaults are complete', () => {
  assert.deepEqual(DEFAULT_ASSISTANT_CONFIG, {
    Enabled: false,
    Owner: { Id: 'own_local', DisplayName: 'Local user' },
    Memory: {
      Tier1: { MaxTokens: 10_000, TargetTokens: 3_500 },
      Tier2: { MaxDocuments: 25, MaxTokensPerDocument: 50_000, TargetTokensPerDocument: 8_000 },
      Tier3: { MaxDocuments: 500, MaxTokensPerDocument: 10_000, TargetTokensPerDocument: 2_500 },
    },
    Retrieval: {
      MaxContextTokens: 1_200,
      MaxHops: 2,
      MaxSeedNodes: 12,
      MaxNodes: 80,
      MaxAssertions: 160,
      MaxFanoutPerNodePredicate: 20,
    },
    Questions: {
      Enabled: true,
      MaxPerDay: 1,
      MaxPerWeek: 3,
      MinimumHoursBetweenQuestions: 20,
      AllowedLocalTimeStart: '18:00',
      AllowedLocalTimeEnd: '21:30',
      DismissedCooldownDays: 7,
      UnansweredExpiryDays: 7,
      SuppressDuringFullscreen: true,
      SuppressDuringDoNotDisturb: true,
      ActiveInputSuppressionSeconds: 120,
    },
    Observation: {
      ActivityMetadataEnabled: true,
      ScreenshotsEnabled: false,
      FixedCadenceMinutes: 10,
      WindowChangeCapture: false,
      MinimumForegroundDwellSeconds: 30,
      MinimumPerceptualDistance: 8,
      CaptureOnlyWhileActive: true,
      SkipFullscreen: true,
      SkipWhileLocked: true,
      RawRetentionHours: 72,
      RawStorageLimitGb: 5,
      AccessibilityExtractionEnabled: true,
      OcrFallbackEnabled: true,
    },
    Retention: { OcrTextDays: 7, UnpromotedObservationDays: 90, RejectedCandidateDays: 30 },
    Background: {
      IdleSecondsBeforeProcessing: 180,
      MaxJobsPerIdleSession: 20,
      MaxGpuMinutesPerDay: 60,
      MinimumBatteryPercent: 50,
      AllowOnBattery: false,
      JobPriorities: {
        ConversationIngestion: 800,
        QuestionAnswerIngestion: 850,
        QuestionPlanning: 600,
        CandidateConsolidation: 400,
        ProjectionMaintenance: 300,
      },
    },
    PrivateMode: { Active: false, ExpiresAtUtc: null },
  });
  assert.deepEqual(AssistantConfigSchema.parse(DEFAULT_ASSISTANT_CONFIG), DEFAULT_ASSISTANT_CONFIG);
  assert.equal(AssistantConfigSchema.safeParse({ ...DEFAULT_ASSISTANT_CONFIG, Extra: true }).success, false);
  assert.equal(AssistantConfigSchema.safeParse({
    ...DEFAULT_ASSISTANT_CONFIG,
    Owner: { ...DEFAULT_ASSISTANT_CONFIG.Owner, Extra: true },
  }).success, false);
});

test('normalizeAssistantConfig repairs each malformed scalar without accepting a mutable owner id', () => {
  assert.deepEqual(normalizeAssistantConfig({}), DEFAULT_ASSISTANT_CONFIG);
  const normalized = normalizeAssistantConfig({
    Enabled: true,
    Owner: { Id: 'another_owner', DisplayName: '  Denys  ' },
    Retrieval: { MaxHops: 99, MaxNodes: -1 },
    Questions: { MaxPerDay: -1, AllowedLocalTimeStart: 3 },
    Background: { MinimumBatteryPercent: 101, AllowOnBattery: true },
  });
  assert.equal(normalized.Enabled, true);
  assert.deepEqual(normalized.Owner, { Id: 'own_local', DisplayName: 'Denys' });
  assert.equal(normalized.Retrieval.MaxHops, 2);
  assert.equal(normalized.Retrieval.MaxNodes, 80);
  assert.equal(normalized.Questions.MaxPerDay, 1);
  assert.equal(normalized.Questions.AllowedLocalTimeStart, '18:00');
  assert.equal(normalized.Background.MinimumBatteryPercent, 50);
  assert.equal(normalized.Background.AllowOnBattery, true);
});

test('assistant config round-trips through assistant_json and synchronizes the durable owner name', async () => {
  await withTempEnv(async (tempRoot) => {
    const databasePath = path.join(tempRoot, 'runtime.sqlite');
    const config = getDefaultConfig();
    config.Assistant.Enabled = true;
    config.Assistant.Owner.DisplayName = 'Denys';
    writeConfig(databasePath, config);

    const database = getRuntimeDatabase(databasePath);
    const stored = database.prepare('SELECT assistant_json FROM app_config WHERE id = 1').get();
    const owner = database.prepare('SELECT id, display_name FROM assistant_owners WHERE id = ?').get('own_local');
    assert.deepEqual(stored, { assistant_json: JSON.stringify(config.Assistant) });
    assert.deepEqual(owner, { id: 'own_local', display_name: 'Denys' });
    assert.deepEqual(readConfig(databasePath).Assistant, config.Assistant);

    config.Assistant.Owner.Id = 'other_owner';
    assert.throws(() => writeConfig(databasePath, config), /Owner\.Id.*own_local/);
  });
});
