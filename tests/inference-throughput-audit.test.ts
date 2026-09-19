import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIXED_MODEL_PRESET_LABEL,
  ThroughputAuditContextSchema,
  ThroughputAuditOperationSchema,
  type InferenceThroughput,
  type ThroughputAuditContext,
} from '@siftkit/contracts';
import {
  readTabbyThroughput,
  mergeInferenceThroughput,
  unmeasuredInferenceThroughput,
  emptyInferenceThroughput,
} from '../src/lib/inference-throughput.js';
import {
  auditInferenceThroughput,
  UNPUBLISHED_RATES,
} from '../src/status-server/inference-throughput-audit.js';
import { ServerLogger } from '../src/status-server/server-logger.js';
import { InferenceClient, type InferenceChatOptions } from '../src/llm-protocol/inference-client.js';
import { getDefaultConfigObject } from '../src/config/defaults.js';
import { TEST_THROUGHPUT_AUDIT } from './_test-helpers.js';

function collect(): { lines: string[]; write: (text: string) => void } {
  const lines: string[] = [];
  return { lines, write: (text: string) => { lines.push(text); } };
}

function logger(options: { level?: 'quiet' | 'normal' | 'debug', colour: boolean }): {
  lines: string[];
  logger: ServerLogger;
} {
  const sink = collect();
  return {
    lines: sink.lines,
    logger: new ServerLogger({ level: options.level ?? 'normal', colour: options.colour, write: sink.write }),
  };
}

const context = {
  operationType: 'repo-agent',
  operationId: 'run-9e65fa15',
  requestId: 'f8d145b1-2222-3333',
  stage: 'planner_action',
  model: 'td_flash-next_4.05bpw_h6_ng6',
  presetId: 'td_flash-next',
  scope: 'request',
} as const satisfies ThroughputAuditContext;

/** One request whose backend says `internal` tokens in `duration` seconds at `rate` tokens/second. */
function observed(input: {
  tokens: number;
  durationSeconds: number;
  reportedRate: number;
}): InferenceThroughput {
  return readTabbyThroughput({
    usage: {
      prompt_tokens: 1_000,
      prompt_time: 2,
      prompt_tokens_per_sec: 500,
      completion_tokens: input.tokens,
      completion_time: input.durationSeconds,
      completion_tokens_per_sec: input.reportedRate,
    },
  });
}

const matching = observed({ tokens: 100, durationSeconds: 5, reportedRate: 20 });

test('the operation identity carries no stage, and the context accepts the mixed aggregate label', () => {
  const operation = ThroughputAuditOperationSchema.parse({
    operationType: 'repo-agent',
    operationId: 'run-9e65fa15',
    requestId: 'f8d145b1-2222-3333',
    model: 'td_flash-next_4.05bpw_h6_ng6',
    presetId: 'td_flash-next',
  });
  assert.equal('stage' in operation, false);
  assert.equal(ThroughputAuditOperationSchema.safeParse({ ...operation, stage: 'planner_action' }).success, false);

  const mixed = ThroughputAuditContextSchema.parse({ ...context, operationType: MIXED_MODEL_PRESET_LABEL });
  assert.equal(mixed.operationType, MIXED_MODEL_PRESET_LABEL);
  assert.equal(ThroughputAuditContextSchema.safeParse({ ...context, operationType: 'not-an-operation' }).success, false);
});

test('omitting the audit identity on a chat call is a compile error', () => {
  const client = new InferenceClient();
  const withoutIdentity = {
    config: getDefaultConfigObject(),
    model: 'local',
    messages: [{ role: 'user' as const, content: 'hello' }],
    tools: [],
    maxTokens: 64,
    allowedToolNames: [],
  };
  const call = () => {
    // @ts-expect-error throughputAudit is required on every InferenceClient.chat call.
    return client.chat(withoutIdentity);
  };
  assert.equal(typeof call, 'function');
  const complete: InferenceChatOptions = { ...withoutIdentity, throughputAudit: TEST_THROUGHPUT_AUDIT };
  assert.equal(complete.throughputAudit.stage, TEST_THROUGHPUT_AUDIT.stage);
});

test('a comparable match logs nothing', () => {
  const capture = logger({ colour: false });
  const result = auditInferenceThroughput(context, matching, UNPUBLISHED_RATES, capture.logger);

  assert.deepEqual(capture.lines, []);
  assert.equal(result.pp?.kind, 'match');
  assert.equal(result.decode?.kind, 'match');
});

test('a decode rate above the threshold is a red mismatch naming both rates and the cohort', () => {
  const capture = logger({ colour: false });
  // Internal 100 / 5 s = 20 tok/s against a backend reference of 30 tok/s.
  const result = auditInferenceThroughput(
    context,
    observed({ tokens: 100, durationSeconds: 5, reportedRate: 30 }),
    UNPUBLISHED_RATES,
    capture.logger,
  );

  assert.equal(result.decode?.kind, 'mismatch');
  assert.equal(capture.lines.length, 1);
  const line = capture.lines[0] ?? '';
  assert.match(line, /throughput_mismatch/u);
  assert.match(line, /inference f8d145b1/u);
  assert.match(line, /operation=repo-agent/u);
  assert.match(line, /operation_id=run-9e65fa15/u);
  assert.match(line, /stage=planner_action/u);
  assert.match(line, /scope=request/u);
  assert.match(line, /metric=decode/u);
  assert.match(line, /internal=20\.0000/u);
  assert.match(line, /tabby=30\.0000/u);
  assert.match(line, /delta_pct=-33\.33/u);
  assert.match(line, /threshold_pct=5/u);
  assert.match(line, /generated_tokens=100/u);
  assert.match(line, /duration_ms=5000/u);
  assert.match(line, /reference_duration_ms=5000/u);
  assert.match(line, /model=td_flash-next_4\.05bpw_h6_ng6/u);
  assert.match(line, /preset=td_flash-next/u);
});

test('an over-reported rate mismatches with a signed positive discrepancy', () => {
  const capture = logger({ colour: false });
  auditInferenceThroughput(
    context,
    observed({ tokens: 300, durationSeconds: 5, reportedRate: 20 }),
    UNPUBLISHED_RATES,
    capture.logger,
  );

  assert.equal(capture.lines.length, 1);
  assert.match(capture.lines[0] ?? '', /internal=60\.0000/u);
  assert.match(capture.lines[0] ?? '', /delta_pct=\+200\.00/u);
});

test('exactly five percent passes in both directions and 5.01 percent does not', () => {
  const atThreshold = logger({ colour: false });
  auditInferenceThroughput(
    context,
    observed({ tokens: 19, durationSeconds: 1, reportedRate: 20 }),
    UNPUBLISHED_RATES,
    atThreshold.logger,
  );
  auditInferenceThroughput(
    context,
    observed({ tokens: 21, durationSeconds: 1, reportedRate: 20 }),
    UNPUBLISHED_RATES,
    atThreshold.logger,
  );
  assert.deepEqual(atThreshold.lines, []);

  const pastThreshold = logger({ colour: false });
  auditInferenceThroughput(
    context,
    observed({ tokens: 1_899, durationSeconds: 100, reportedRate: 20 }),
    UNPUBLISHED_RATES,
    pastThreshold.logger,
  );
  auditInferenceThroughput(
    context,
    observed({ tokens: 2_101, durationSeconds: 100, reportedRate: 20 }),
    UNPUBLISHED_RATES,
    pastThreshold.logger,
  );
  assert.equal(pastThreshold.lines.length, 2);
  assert.match(pastThreshold.lines[0] ?? '', /delta_pct=-5\.05/u);
  assert.match(pastThreshold.lines[1] ?? '', /delta_pct=\+5\.05/u);
});

test('a prefill-only mismatch audits pp alone, and both metrics report independently', () => {
  const prefillOnly = readTabbyThroughput({
    usage: {
      prompt_tokens: 1_000,
      prompt_time: 2,
      prompt_tokens_per_sec: 900,
      completion_tokens: 100,
      completion_time: 5,
      completion_tokens_per_sec: 20,
    },
  });
  const capture = logger({ colour: false });
  auditInferenceThroughput(context, prefillOnly, UNPUBLISHED_RATES, capture.logger);

  assert.equal(capture.lines.length, 1);
  assert.match(capture.lines[0] ?? '', /metric=pp/u);
  assert.match(capture.lines[0] ?? '', /prompt_tokens=1000/u);

  const both = readTabbyThroughput({
    usage: {
      prompt_tokens: 1_000,
      prompt_time: 2,
      prompt_tokens_per_sec: 900,
      completion_tokens: 100,
      completion_time: 5,
      completion_tokens_per_sec: 40,
    },
  });
  const bothCapture = logger({ colour: false });
  auditInferenceThroughput(context, both, UNPUBLISHED_RATES, bothCapture.logger);
  assert.equal(bothCapture.lines.length, 2);
  assert.match(bothCapture.lines[0] ?? '', /metric=pp/u);
  assert.match(bothCapture.lines[1] ?? '', /metric=decode/u);
});

test('an explicit zero reference with a positive internal rate reports zero_reference without a percentage', () => {
  const capture = logger({ colour: false });
  const result = auditInferenceThroughput(
    context,
    observed({ tokens: 100, durationSeconds: 5, reportedRate: 0 }),
    UNPUBLISHED_RATES,
    capture.logger,
  );

  assert.equal(result.decode?.kind, 'mismatch');
  assert.equal(capture.lines.length, 1);
  assert.match(capture.lines[0] ?? '', /reason=zero_reference/u);
  assert.doesNotMatch(capture.lines[0] ?? '', /delta_pct=/u);
});

test('missing backend telemetry is an unverifiable error naming the missing fields, never silence', () => {
  const capture = logger({ colour: false });
  const result = auditInferenceThroughput(
    context,
    unmeasuredInferenceThroughput(),
    UNPUBLISHED_RATES,
    capture.logger,
  );

  assert.equal(result.pp?.kind, 'unverifiable');
  assert.equal(capture.lines.length, 2);
  assert.match(capture.lines[0] ?? '', /throughput_unverifiable/u);
  assert.match(capture.lines[0] ?? '', /metric=pp/u);
  assert.match(capture.lines[0] ?? '', /reason=both_unavailable/u);
  assert.match(capture.lines[0] ?? '', /missing=internal_tokens,internal_duration_ms,tabby_rate,tabby_duration_ms/u);
  assert.match(capture.lines[0] ?? '', /internal=unavailable/u);
  assert.match(capture.lines[0] ?? '', /tabby=unavailable/u);
  assert.match(capture.lines[1] ?? '', /metric=decode/u);
});

test('an operation that never invoked a model has nothing to audit', () => {
  const capture = logger({ colour: false });
  const result = auditInferenceThroughput(context, emptyInferenceThroughput(), UNPUBLISHED_RATES, capture.logger);

  assert.deepEqual(capture.lines, []);
  assert.equal(result.pp, null);
  assert.equal(result.decode, null);
});

test('a published audit checks the rate about to leave the consumer, not the pristine fold', () => {
  const capture = logger({ colour: false });
  // The fold itself is internally consistent; the consumer's published decode rate is the original bug.
  const result = auditInferenceThroughput(
    { ...context, scope: 'published' },
    matching,
    { pp: null, decode: 16.5198 },
    capture.logger,
  );

  assert.equal(result.decode?.kind, 'mismatch');
  assert.equal(result.pp, null);
  assert.equal(capture.lines.length, 1);
  assert.match(capture.lines[0] ?? '', /scope=published/u);
  assert.match(capture.lines[0] ?? '', /metric=decode/u);
  assert.match(capture.lines[0] ?? '', /internal=16\.5198/u);
  assert.match(capture.lines[0] ?? '', /tabby=20\.0000/u);
});

test('a published audit stays silent when the consumer publishes no rate for that metric', () => {
  const capture = logger({ colour: false });
  const result = auditInferenceThroughput(
    { ...context, scope: 'published' },
    matching,
    { pp: null, decode: null },
    capture.logger,
  );

  assert.deepEqual(capture.lines, []);
  assert.equal(result.decode, null);
});

test('an aggregate whose cohort is only partly measured is never presented as comparable', () => {
  const partial = mergeInferenceThroughput([matching, unmeasuredInferenceThroughput()]);
  const capture = logger({ colour: false });
  const result = auditInferenceThroughput(
    { ...context, scope: 'published' },
    partial,
    { pp: null, decode: 20 },
    capture.logger,
  );

  assert.equal(result.decode?.kind, 'unverifiable');
  assert.equal(capture.lines.length, 1);
  assert.match(capture.lines[0] ?? '', /throughput_unverifiable/u);
  assert.match(capture.lines[0] ?? '', /reason=reference_unavailable/u);
  assert.match(capture.lines[0] ?? '', /requests=2/u);
  assert.match(capture.lines[0] ?? '', /missing_reference_requests=1/u);
});

test('request and published scopes are distinct audits and are never deduplicated', () => {
  const capture = logger({ colour: false });
  auditInferenceThroughput(context, matching, UNPUBLISHED_RATES, capture.logger);
  auditInferenceThroughput({ ...context, scope: 'published' }, matching, { pp: null, decode: 60 }, capture.logger);

  assert.equal(capture.lines.length, 1);
  assert.match(capture.lines[0] ?? '', /scope=published/u);

  const drifting = observed({ tokens: 100, durationSeconds: 5, reportedRate: 30 });
  const bothScopes = logger({ colour: false });
  auditInferenceThroughput(context, drifting, UNPUBLISHED_RATES, bothScopes.logger);
  auditInferenceThroughput({ ...context, scope: 'published' }, drifting, { pp: null, decode: 60 }, bothScopes.logger);
  assert.equal(bothScopes.lines.length, 2);
  assert.match(bothScopes.lines[0] ?? '', /scope=request/u);
  assert.match(bothScopes.lines[1] ?? '', /scope=published/u);
});

const ESCAPE = String.fromCharCode(27);
const ANSI_RED = ESCAPE + '[31m';
const ANSI_RESET = ESCAPE + '[0m';
const ANSI_SCOPE = ESCAPE + '[36m';

test('the mismatch error prints at quiet level in red with an ANSI reset', () => {
  const capture = logger({ level: 'quiet', colour: true });
  auditInferenceThroughput(
    context,
    observed({ tokens: 100, durationSeconds: 5, reportedRate: 30 }),
    UNPUBLISHED_RATES,
    capture.logger,
  );

  const line = capture.lines[0] ?? '';
  assert.equal(capture.lines.length, 1);
  assert.match(line, /throughput_mismatch/u);
  assert.match(line, /metric=decode/u);
  assert.ok(line.includes(ANSI_RED), 'the event and its whole body are red');
  assert.ok(line.trimEnd().endsWith(ANSI_RESET), 'the red span is closed');
  assert.ok(line.indexOf(ANSI_RED) > line.indexOf(ANSI_SCOPE), 'only the timestamp and scope keep their own colours');
});

test('the mismatch error stays readable when colour is disabled', () => {
  const capture = logger({ level: 'quiet', colour: false });
  auditInferenceThroughput(
    context,
    observed({ tokens: 100, durationSeconds: 5, reportedRate: 30 }),
    UNPUBLISHED_RATES,
    capture.logger,
  );

  const line = capture.lines[0] ?? '';
  assert.ok(!line.includes(ESCAPE));
  assert.match(line, /throughput_mismatch  operation=repo-agent/u);
});


test('a malformed audit input logs a telemetry error instead of throwing into generation', () => {
  const capture = logger({ colour: false });
  const result = auditInferenceThroughput(
    context,
    matching,
    { pp: null, decode: Number.NaN },
    capture.logger,
  );

  assert.equal(capture.lines.length, 1);
  assert.match(capture.lines[0] ?? '', /throughput_audit_failed/u);
  assert.equal(result.pp, null);
  assert.equal(result.decode, null);
});

