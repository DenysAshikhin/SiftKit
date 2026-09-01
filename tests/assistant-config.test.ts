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
      FixedCadenceSeconds: 30,
      WindowChangeCapture: false,
      MinimumForegroundDwellSeconds: 5,
      DuplicateSimilarityPercent: 92,
      CaptureScope: 'foreground_window',
      CaptureOnlyWhileActive: true,
      SkipFullscreen: true,
      SkipWhileLocked: true,
      RawRetentionHours: 72,
      RawStorageLimitGb: 5,
      AccessibilityExtractionEnabled: true,
      OcrFallbackEnabled: true,
      ProcessDenyList: [],
      TitleDenyPatterns: [],
      StartOnSignIn: false,
    },
    Retention: { OcrTextDays: 7, UnpromotedObservationDays: 90, RejectedCandidateDays: 30 },
    Background: {
      IdleSecondsBeforeProcessing: 180,
      MaxJobsPerIdleSession: -1,
      MaxGpuMinutesPerDay: -1,
      MinimumBatteryPercent: 50,
      AllowOnBattery: false,
      JobPriorities: {
        ConversationIngestion: 800,
        QuestionAnswerIngestion: 850,
        QuestionPlanning: 600,
        CandidateConsolidation: 400,
        ImageExtraction: 350,
        CaptureRetention: 900,
        ProjectionMaintenance: 300,
      },
    },
    PrivateMode: { Active: false, ExpiresAtUtc: null },
    Mobile: { Enabled: false },
    KeyCustody: 'file',
  });
  assert.deepEqual(AssistantConfigSchema.parse(DEFAULT_ASSISTANT_CONFIG), DEFAULT_ASSISTANT_CONFIG);
  assert.equal(AssistantConfigSchema.safeParse({ ...DEFAULT_ASSISTANT_CONFIG, Extra: true }).success, false);
  assert.equal(AssistantConfigSchema.safeParse({
    ...DEFAULT_ASSISTANT_CONFIG,
    Owner: { ...DEFAULT_ASSISTANT_CONFIG.Owner, Extra: true },
  }).success, false);
});

test('the background budgets accept -1 as unlimited, keep 0 as zero, and reject -2', () => {
  const unlimited = normalizeAssistantConfig({
    Background: { MaxJobsPerIdleSession: -1, MaxGpuMinutesPerDay: -1 },
  }).Background;
  assert.equal(unlimited.MaxJobsPerIdleSession, -1);
  assert.equal(unlimited.MaxGpuMinutesPerDay, -1);

  const rejected = normalizeAssistantConfig({
    Background: { MaxJobsPerIdleSession: -2, MaxGpuMinutesPerDay: -2 },
  }).Background;
  assert.equal(rejected.MaxJobsPerIdleSession, DEFAULT_ASSISTANT_CONFIG.Background.MaxJobsPerIdleSession);
  assert.equal(rejected.MaxGpuMinutesPerDay, DEFAULT_ASSISTANT_CONFIG.Background.MaxGpuMinutesPerDay);

  const zero = normalizeAssistantConfig({
    Background: { MaxJobsPerIdleSession: 0, MaxGpuMinutesPerDay: 0 },
  }).Background;
  assert.equal(zero.MaxJobsPerIdleSession, 0);
  assert.equal(zero.MaxGpuMinutesPerDay, 0);
});

test('AssistantConfigSchema accepts -1 for the background budgets and rejects -2', () => {
  const unlimited = {
    ...DEFAULT_ASSISTANT_CONFIG,
    Background: {
      ...DEFAULT_ASSISTANT_CONFIG.Background,
      MaxJobsPerIdleSession: -1,
      MaxGpuMinutesPerDay: -1,
    },
  };
  assert.deepEqual(AssistantConfigSchema.parse(unlimited), unlimited);
  assert.equal(AssistantConfigSchema.safeParse({
    ...DEFAULT_ASSISTANT_CONFIG,
    Background: {
      ...DEFAULT_ASSISTANT_CONFIG.Background,
      MaxJobsPerIdleSession: -2,
      MaxGpuMinutesPerDay: -2,
    },
  }).success, false);
});

test('observation config uses gate D fields and rejects the removed provisional ones', () => {
  const parsed = AssistantConfigSchema.parse(DEFAULT_ASSISTANT_CONFIG);
  assert.equal(parsed.Observation.FixedCadenceSeconds, 30);
  assert.equal(parsed.Observation.DuplicateSimilarityPercent, 92);
  assert.equal(parsed.Observation.CaptureScope, 'foreground_window');
  assert.equal(parsed.KeyCustody, 'file');

  assert.equal(AssistantConfigSchema.safeParse({
    ...DEFAULT_ASSISTANT_CONFIG,
    Observation: { ...DEFAULT_ASSISTANT_CONFIG.Observation, FixedCadenceMinutes: 1 },
  }).success, false);
  assert.equal(AssistantConfigSchema.safeParse({
    ...DEFAULT_ASSISTANT_CONFIG,
    Observation: { ...DEFAULT_ASSISTANT_CONFIG.Observation, MinimumPerceptualDistance: 8 },
  }).success, false);
  assert.equal(AssistantConfigSchema.safeParse({
    ...DEFAULT_ASSISTANT_CONFIG,
    Observation: { ...DEFAULT_ASSISTANT_CONFIG.Observation, CaptureScope: 'single_monitor' },
  }).success, false);
  assert.equal(AssistantConfigSchema.safeParse({ ...DEFAULT_ASSISTANT_CONFIG, KeyCustody: 'tpm' }).success, false);
});

test('normalizeAssistantConfig repairs gate D observation scalars and key custody', () => {
  assert.deepEqual(normalizeAssistantConfig({
    Observation: { FixedCadenceSeconds: 0, DuplicateSimilarityPercent: 500, CaptureScope: 'nonsense' },
    KeyCustody: 'nonsense',
  }).Observation, DEFAULT_ASSISTANT_CONFIG.Observation);
  assert.equal(normalizeAssistantConfig({ KeyCustody: 'nonsense' }).KeyCustody, 'file');
  const normalized = normalizeAssistantConfig({
    Observation: { FixedCadenceSeconds: 5, DuplicateSimilarityPercent: 80, CaptureScope: 'all_monitors' },
    KeyCustody: 'desktop',
  });
  assert.equal(normalized.Observation.FixedCadenceSeconds, 5);
  assert.equal(normalized.Observation.DuplicateSimilarityPercent, 80);
  assert.equal(normalized.Observation.CaptureScope, 'all_monitors');
  assert.equal(normalized.KeyCustody, 'desktop');
});

test('normalizeAssistantConfig repairs the deny lists and the sign-in startup flag', () => {
  const repaired = normalizeAssistantConfig({
    Observation: {
      ProcessDenyList: ['obs64.exe', 3, 'keepass.exe'],
      TitleDenyPatterns: 'bank',
      StartOnSignIn: 'yes',
    },
  }).Observation;
  assert.deepEqual(repaired.ProcessDenyList, ['obs64.exe', 'keepass.exe']);
  assert.deepEqual(repaired.TitleDenyPatterns, []);
  assert.equal(repaired.StartOnSignIn, false);

  const kept = normalizeAssistantConfig({
    Observation: {
      ProcessDenyList: ['obs64.exe'],
      TitleDenyPatterns: ['.*bank.*'],
      StartOnSignIn: true,
    },
  }).Observation;
  assert.deepEqual(kept.ProcessDenyList, ['obs64.exe']);
  assert.deepEqual(kept.TitleDenyPatterns, ['.*bank.*']);
  assert.equal(kept.StartOnSignIn, true);
});

test('the mobile envelope gate defaults off and rejects unknown keys', () => {
  assert.deepEqual(normalizeAssistantConfig({}).Mobile, { Enabled: false });
  assert.deepEqual(normalizeAssistantConfig({ Mobile: { Enabled: 'yes' } }).Mobile, { Enabled: false });
  assert.deepEqual(normalizeAssistantConfig({ Mobile: { Enabled: true } }).Mobile, { Enabled: true });

  assert.equal(AssistantConfigSchema.safeParse({
    ...DEFAULT_ASSISTANT_CONFIG,
    Mobile: { Enabled: true },
  }).success, true);
  assert.equal(AssistantConfigSchema.safeParse({
    ...DEFAULT_ASSISTANT_CONFIG,
    Mobile: { Enabled: true, Port: 8080 },
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
