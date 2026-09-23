import type { JsonObject } from '../../src/lib/json-types.js';
import type { ChatHistoryRepairInputSchema } from '../../src/status-server/chat-history-repair.js';
import type { getRuntimeDatabase } from '../../src/state/runtime-db.js';
import type { z } from '../../src/lib/zod.js';

const SEEDED_AT = '2026-09-10T11:00:00.000Z';

export function chatArchiveSource(text: string, sourceId = 'artifact') {
  return { sourceKind: 'runtime_artifact' as const, sourceId, text };
}

export function repairInput(): z.input<typeof ChatHistoryRepairInputSchema> {
  const fixture = createChatHistoryArchiveFixture();
  const runId = '074bbeb7-1111-4111-8111-111111111111';
  return { sessionId: 'session', requestId: 'request', sources: [chatArchiveSource(fixture.text)], savedMessages: [],
    includeThinking: true, maxTurns: 200,
    request: { runId, task: 'Inspect fixture safely.', repoRoot: 'C:\\fixture', approval: 'auto', images: [] },
    state: { runId, revision: 3, updatedAtUtc: '2026-09-10T12:20:00.000Z', status: 'approval_timeout', pid: 123,
      approval: { approvalId: 'e08682f5-1111-4111-8111-111111111111', toolName: 'run', command: 'Remove-Item fixture.tmp', reviewPayload: null } },
  };
}

export function seedRepairArchive(database: ReturnType<typeof getRuntimeDatabase>) {
  const input = repairInput();
  for (const archive of input.sources) database.prepare(`INSERT INTO runtime_artifacts
    (id, artifact_kind, request_id, title, content_text, content_json, created_at_utc, updated_at_utc)
    VALUES (?, 'repo_search_transcript', ?, 'fixture', ?, NULL, ?, ?)`)
    .run(archive.sourceId, input.requestId, archive.text, SEEDED_AT, SEEDED_AT);
}

/** Private incident structure only. All prompts, reasoning, paths, and outputs are synthetic. */
export function createChatHistoryArchiveFixture(options: { repeatedOutcomes?: boolean } = {}) {
  const queueId = '01974141-1111-4111-8111-111111111111';
  const events: JsonObject[] = [{ kind: 'run_start', operationType: 'repo-agent', toolResultFormat: 'identified-v1', repoRoot: 'C:\\fixture' }];
  let fresh: JsonObject[] = [{ role: 'system', content: 'Synthetic fixture policy.' }, { role: 'user', content: 'Task: Inspect fixture safely.' }];
  let callCount = 0;
  for (let turn = 1; turn <= 103; turn++) {
    if (turn === 41) {
      events.push({ kind: 'queued_user_message', id: queueId, turn, boundary: 'post_tool_batch', content: 'Preserve fixture data.', images: [] });
      fresh.push({ role: 'user', content: 'Preserve fixture data.' });
    }
    if (turn === 85) {
      events.push({ kind: 'turn_preflight_compaction_applied', turn, droppedMessageCount: 200 });
      fresh = [{ role: 'system', content: 'Synthetic fixture policy.' },
        { role: 'assistant', content: '[CONTEXT COMPACTED — SUMMARY OF PRIOR CONVERSATION]\nFixture progress; preserve data.' }, ...fresh];
    }
    events.push({ kind: 'turn_new_messages', turn, messages: fresh });
    const repeated = options.repeatedOutcomes && (turn === 96 || turn === 98);
    const responseText = repeated ? '' : `Fixture turn ${turn}.`;
    events.push({ kind: 'turn_model_response', turn, text: responseText, thinkingText: `Fixture reasoning ${turn}.`,
      promptTokens: 100 + turn, completionTokens: 4, thinkingTokens: 4,
      completionTokensEstimated: false, thinkingTokensEstimated: false });
    const calls: JsonObject[] = [];
    const results: JsonObject[] = [];
    for (let index = 0; index < (turn === 103 ? 0 : turn <= 14 ? 2 : 1); index++) {
      const displayId = `tc_${callCount++}`;
      const nativeId = `native-${turn}-${index}`;
      const command = `read fixture-${displayId}.txt`;
      const output = repeated ? 'Identical successful result.' : `Full fixture output ${displayId}: ${'retained '.repeat(30)}`;
      calls.push({ id: nativeId, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: `fixture-${displayId}.txt` }) } });
      events.push({ kind: 'turn_command_start', turn, toolCallId: displayId, toolName: 'read', commandToRun: command });
      const rejected = displayId === 'tc_95';
      events.push(rejected
        ? { kind: 'turn_command_result', turn, toolCallId: displayId, toolName: 'read', command, exitCode: null, output,
          rejectionKind: 'duplicate', rejectionReason: 'Fixture duplicate.' }
        : { kind: 'turn_command_result', turn, toolCallId: displayId, requestedCommand: command, executedCommand: command,
          command, exitCode: 0, output, insertedResultText: output, resultTokenCount: 50 });
      results.push({ role: 'tool', tool_call_id: nativeId, content: output });
    }
    fresh = [{ role: 'assistant', content: responseText, reasoning_content: `Fixture reasoning ${turn}.`, tool_calls: calls }, ...results];
  }
  return { queueId, text: events.map((event, index) => JSON.stringify({ at: new Date(Date.UTC(2026, 8, 10, 11, 0, index)).toISOString(), ...event })).join('\n') };
}
