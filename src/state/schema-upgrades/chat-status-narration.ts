import { z } from '../../lib/zod.js';
import type { RuntimeDatabase } from '../database-handle.js';

const HiddenStatusRowsSchema = z.array(z.object({ session_id: z.string(), id: z.string() }));
/** Only a turn-scoped narration identity was ever hidden; the run-wide progress row keeps its kind. */
const NARRATION_ID_PATTERN = /-narration-\d+$/u;

/**
 * 75 -> 76. Builds up to 75 hid a turn's status update on `tool_start` by storing it as
 * `assistant_progress`; status updates now keep their narration kind, so stored ones are restored.
 */
export function upgradeChatStatusNarration(database: RuntimeDatabase): void {
  const rows = HiddenStatusRowsSchema.parse(database.prepare(
    "SELECT session_id, id FROM chat_messages WHERE kind = 'assistant_progress'",
  ).all());
  const update = database.prepare("UPDATE chat_messages SET kind = 'assistant_narration' WHERE session_id = ? AND id = ?");
  for (const row of rows) {
    if (NARRATION_ID_PATTERN.test(row.id)) update.run(row.session_id, row.id);
  }
}
