import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { z } from '../src/lib/zod.js';

const since = process.argv.includes('--since')
  ? process.argv[process.argv.indexOf('--since') + 1] ?? ''
  : '';
if (!since) {
  console.error('usage: npx tsx scripts/report-invalid-action-rate.ts --since YYYY-MM-DD');
  process.exit(2);
}

const db = new Database(resolve('.siftkit/runtime.sqlite'), { readonly: true });
const rows = z.array(z.object({
  request_id: z.string(),
  started_at_utc: z.string(),
  run_kind: z.string(),
  repo_search_transcript_jsonl: z.string().nullable(),
})).parse(db.prepare(
  'select request_id, started_at_utc, run_kind, repo_search_transcript_jsonl from run_logs where started_at_utc >= ? order by started_at_utc',
).all(since));

const TranscriptLineSchema = z.looseObject({
  kind: z.string(),
  error: z.string().optional(),
  reason: z.string().optional(),
  toolAction: z.looseObject({
    args: z.looseObject({ rawResponseText: z.string().optional() }).optional(),
  }).optional(),
});
type TranscriptLine = z.infer<typeof TranscriptLineSchema>;

function parseTranscriptLine(line: string): TranscriptLine | null {
  try {
    return TranscriptLineSchema.parse(JSON.parse(line));
  } catch {
    return null;
  }
}

/**
 * Attribution order: the tool named by the error text, else the tool the rejected
 * payload claimed. Pre-fix errors ("expected record, received string") name neither
 * the tool nor the run that produced them, so the payload is the only signal.
 */
function resolveImplicatedTool(event: TranscriptLine): string {
  const fromError = /"([a-z_]+)"/u.exec(event.error ?? '')?.[1];
  if (fromError) return fromError;
  const fromPayload = /"toolName"\s*:\s*"([a-z_]+)"/u.exec(event.toolAction?.args?.rawResponseText ?? '')?.[1];
  return fromPayload ?? 'unknown';
}
let runs = 0;
let runsWithStrikes = 0;
let runsKilled = 0;
const strikesByTool = new Map<string, number>();

for (const row of rows) {
  if (!row.repo_search_transcript_jsonl) continue;
  runs += 1;
  let strikes = 0;
  for (const line of row.repo_search_transcript_jsonl.split('\n')) {
    if (!line.trim()) continue;
    const event = parseTranscriptLine(line);
    if (!event) continue;
    if (event.kind === 'turn_action_invalid') {
      strikes += 1;
      const tool = resolveImplicatedTool(event);
      strikesByTool.set(tool, (strikesByTool.get(tool) ?? 0) + 1);
    }
    if (event.kind === 'task_done' && event.reason === 'invalid_response_limit') {
      runsKilled += 1;
    }
  }
  if (strikes > 0) runsWithStrikes += 1;
}

db.close();
console.log(`runs since ${since}: ${runs}`);
console.log(`runs with >=1 invalid action: ${runsWithStrikes} (${runs > 0 ? ((100 * runsWithStrikes) / runs).toFixed(1) : '0'}%)`);
console.log(`runs killed by invalid_response_limit: ${runsKilled}`);
console.log('strikes by implicated token:');
for (const [tool, count] of [...strikesByTool.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${tool}: ${count}`);
}
