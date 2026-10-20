import { ChatRunEffectiveSettingsSchema } from '@siftkit/contracts';
import { z } from '../../lib/zod.ts';
import { JsonObjectSchema } from '../../lib/json-types.ts';
import { digestStableJson } from '../../lib/json-digest.ts';
import { parseJsonValueText } from '../../lib/json.ts';
import { ChatRunStartedEventSchema } from '../chat-journal-schema.ts';
import type { RuntimeDatabase } from '../database-handle.ts';

const HistoricSettingsSchema = ChatRunEffectiveSettingsSchema.pick({
  operationKind: true, mode: true, presetId: true, modelPresetId: true, modelPresetOverrideId: true, model: true,
  repoRoot: true, approval: true, maxTurns: true, thinkingEnabled: true, webSearchEnabled: true, contextWindowTokens: true,
}).partial({ modelPresetOverrideId: true });
const HistoricStartedSchema = ChatRunStartedEventSchema.pick({
  kind: true, sessionId: true, operationKind: true, runOrder: true, userMessageId: true,
  content: true, images: true, imageMeta: true, settings: true, retainedHistoryRevision: true,
}).extend({ settings: HistoricSettingsSchema });
const SettingsRowsSchema = z.array(z.object({ operation_id: z.string(), effective_settings_json: z.string() }));
const EventRowsSchema = z.array(z.object({ operation_id: z.string(), sequence: z.number(), event_id: z.string(), body_json: z.string(), payload_digest: z.string() }));

/** Schema 81 -> 82: inherited choices become explicit null; journal hashes keep their integrity. */
export function upgradeExplicitChatModelSelection(database: RuntimeDatabase): void {
  const runs = SettingsRowsSchema.parse(database.prepare('SELECT operation_id, effective_settings_json FROM chat_runs WHERE effective_settings_json IS NOT NULL').all());
  for (const run of runs) {
    const settings = HistoricSettingsSchema.parse(parseJsonValueText(run.effective_settings_json));
    if (settings.modelPresetOverrideId !== undefined) continue;
    database.prepare('UPDATE chat_runs SET effective_settings_json = ? WHERE operation_id = ?')
      .run(JSON.stringify({ ...settings, modelPresetOverrideId: null }), run.operation_id);
  }
  const events = EventRowsSchema.parse(database.prepare("SELECT operation_id, sequence, event_id, body_json, payload_digest FROM chat_run_events WHERE kind = 'run_started'").all());
  for (const row of events) {
    const body = JsonObjectSchema.parse(parseJsonValueText(row.body_json));
    if (digestStableJson(body) !== row.payload_digest) throw new Error(`Chat journal event ${row.event_id} has a corrupt payload digest.`);
    const event = HistoricStartedSchema.parse(body);
    if (event.settings.modelPresetOverrideId !== undefined) continue;
    const upgraded = { ...event, settings: { ...event.settings, modelPresetOverrideId: null } };
    database.prepare('UPDATE chat_run_events SET body_json = ?, payload_digest = ? WHERE operation_id = ? AND sequence = ?')
      .run(JSON.stringify(upgraded), digestStableJson(upgraded), row.operation_id, row.sequence);
  }
}
