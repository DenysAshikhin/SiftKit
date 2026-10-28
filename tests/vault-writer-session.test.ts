import test from 'node:test';
import assert from 'node:assert/strict';

import { BUDGET_SPENT_NOTICE, VAULT_WRITER_MAX_TURNS, VaultWriterSession } from '../src/vault/note-writer/agent/session.ts';
import { VaultWriterTools } from '../src/vault/note-writer/agent/tools.ts';
import { ScriptedAgentInference, submitTurn, textTurn, toolTurn, type FakeAgentTurn } from './helpers/assistant-inference-fake.ts';
import { TEST_META, entityInput, withVaultAsync, type VaultTestContext } from './helpers/vault-fixture.ts';

function session(context: VaultTestContext, inference: ScriptedAgentInference, signal = new AbortController().signal) {
  return new VaultWriterSession({
    systemPrompt: 'sys', seedText: 'seed', images: [], inference, abortSignal: signal,
    tools: new VaultWriterTools({ database: context.database, store: context.store, clock: context.clock, day: '2026-10-24' }),
  });
}

test('tool results flow back to the model and submit_edits ends the run with the operations', async () => {
  await withVaultAsync(async (context) => {
    context.store.create(entityInput('Neovim', 'Editor.'), TEST_META);
    const inference = new ScriptedAgentInference([
      toolTurn('read_note', { title: 'Neovim' }),
      submitTurn([{ op: 'add_facts', note: 'Neovim', label: 'Uses', values: ['Lua'] }]),
    ]);
    const outcome = await session(context, inference).run();
    assert.deepEqual(outcome, {
      kind: 'submitted', operations: [{ op: 'add_facts', note: 'Neovim', label: 'Uses', values: ['Lua'] }],
      trace: { turns: 2, toolCalls: ['read_note', 'submit_edits'] },
    });
    const first = inference.requests[0]?.messages ?? [];
    assert.deepEqual(first.map((message) => [message.role, message.content]), [['system', 'sys'], ['user', 'seed']]);
    const second = inference.requests[1]?.messages ?? [];
    assert.equal(second.at(-2)?.role, 'assistant');
    assert.equal(second.at(-2)?.tool_calls?.[0]?.function.name, 'read_note');
    assert.equal(second.at(-1)?.role, 'tool');
    assert.equal(second.at(-1)?.tool_call_id, second.at(-2)?.tool_calls?.[0]?.id);
    assert.match(String(second.at(-1)?.content), /^# Neovim/);
  });
});

test('a bad tool argument comes back as a tool error the model corrects', async () => {
  await withVaultAsync(async (context) => {
    const inference = new ScriptedAgentInference([toolTurn('read_note', { title: '' }), submitTurn([])]);
    const outcome = await session(context, inference).run();
    assert.equal(outcome.kind, 'submitted');
    const corrected = inference.requests[1]?.messages.at(-1);
    assert.equal(corrected?.role, 'tool');
    assert.match(String(corrected?.content), /^Error: .*title/);
  });
});

test('an invalid submit_edits comes back as an error, not a commit', async () => {
  await withVaultAsync(async (context) => {
    const inference = new ScriptedAgentInference([submitTurn([{ op: 'delete_note', note: 'Neovim' }]), submitTurn([])]);
    const outcome = await session(context, inference).run();
    assert.equal(outcome.kind, 'submitted');
    if (outcome.kind === 'submitted') assert.deepEqual(outcome.operations, []);
    assert.match(String(inference.requests[1]?.messages.at(-1)?.content), /^Error: /);
  });
});

test('no tool call gets one reminder, then the run fails as invalid_output', async () => {
  await withVaultAsync(async (context) => {
    const inference = new ScriptedAgentInference([textTurn('I think it is fine.'), textTurn('Still fine.')]);
    const outcome = await session(context, inference).run();
    assert.equal(outcome.kind, 'invalid_output');
    if (outcome.kind === 'invalid_output') assert.equal(outcome.rawSample, 'Still fine.');
    assert.equal(inference.requests.length, 2);
    assert.match(String(inference.requests[1]?.messages.at(-1)?.content), /submit_edits/);
  });
});

test('the turn cap forces a final submit-only turn with the budget notice', async () => {
  await withVaultAsync(async (context) => {
    const reads: FakeAgentTurn[] = Array.from({ length: VAULT_WRITER_MAX_TURNS - 1 }, () => toolTurn('day_context', {}));
    // A huge window keeps the 75% rule out of the way, so only the turn cap forces.
    const inference = new ScriptedAgentInference([...reads, submitTurn([])], { contextTokens: 1_000_000_000 });
    const outcome = await session(context, inference).run();
    assert.equal(outcome.kind, 'submitted');
    assert.equal(inference.requests.length, VAULT_WRITER_MAX_TURNS);
    assert.deepEqual(inference.requests.at(-2)?.tools.map((tool) => tool.function.name).length, 5);
    const last = inference.requests.at(-1);
    assert.deepEqual(last?.tools.map((tool) => tool.function.name), ['submit_edits']);
    assert.equal(last?.messages.at(-1)?.content, BUDGET_SPENT_NOTICE);
  });
});

test('reaching 75% of the context window forces the final turn early; a forced turn that does not submit is invalid_output', async () => {
  await withVaultAsync(async (context) => {
    const inference = new ScriptedAgentInference([toolTurn('day_context', {}), toolTurn('day_context', {})], { contextTokens: 1_000, promptTokensPerTurn: 800 });
    const outcome = await session(context, inference).run();
    assert.equal(outcome.kind, 'invalid_output');
    assert.equal(inference.requests.length, 2);
    assert.deepEqual(inference.requests[1]?.tools.map((tool) => tool.function.name), ['submit_edits']);
  });
});

test('an abort mid-loop ends the run as aborted', async () => {
  await withVaultAsync(async (context) => {
    const controller = new AbortController();
    const inference = new ScriptedAgentInference([toolTurn('day_context', {}), submitTurn([])]);
    inference.abortOnTurn = { turn: 2, controller };
    assert.deepEqual(await session(context, inference, controller.signal).run(), { kind: 'aborted' });
  });
});

test('an abort that lands after submit_edits returned keeps the submission', async () => {
  await withVaultAsync(async (context) => {
    const controller = new AbortController();
    class AbortAfterReply extends ScriptedAgentInference {
      override async chat(request: Parameters<ScriptedAgentInference['chat']>[0]) {
        const response = await super.chat(request);
        controller.abort();
        return response;
      }
    }
    const outcome = await session(context, new AbortAfterReply([submitTurn([])]), controller.signal).run();
    assert.equal(outcome.kind, 'submitted');
  });
});

test('a model failure that is not an abort propagates', async () => {
  await withVaultAsync(async (context) => {
    await assert.rejects(session(context, new ScriptedAgentInference([])).run(), /ran out of turns/);
  });
});
