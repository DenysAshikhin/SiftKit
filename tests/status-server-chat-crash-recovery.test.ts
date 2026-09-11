import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { ChatSessionResponseSchema, ChatMessageQueueResponseSchema, type ChatSessionOperationKind } from '@siftkit/contracts';
import { z } from '../src/lib/zod.js';
import { toError } from '../src/lib/errors.js';
import { ChatJournalStore } from '../src/state/chat-journal.js';
import { CHAT_OWNER_LEASE_MS } from '../src/state/chat-runtime-owner.js';
import { extractContentText } from '../src/llm-protocol/image-attachments.js';
import { PlannerChatMessagesSchema, findPlannerContextViolation } from '../src/repo-search/planner-chat-message.js';
import { ChatRecoveryProcess, ChatRecoveryProcessConfigSchema, ChatRecoveryBarrierSchema, RECOVERY_CHILD_ENV, runChatRecoveryProcess } from './helpers/chat-recovery-process.js';
import { GatedChatBackend } from './helpers/gated-chat-backend.js';
import { requestJson, requestSse } from './helpers/dashboard-http.js';
import { readChatStream } from './helpers/chat-stream-views.js';
import { createManagedTempDir, removeDirectoryWithRetries } from './helpers/temp-dirs.js';
import { rasterBuffer, toDataUrl } from './helpers/image-fixtures.js';

// Captured native messages may carry null content (tool-call-only assistant turns); treat it as empty text.
const messageText = (content: Parameters<typeof extractContentText>[0] | null): string => content === null ? '' : extractContentText(content);

const childConfig = process.env[RECOVERY_CHILD_ENV];
if (childConfig !== undefined) {
  await runChatRecoveryProcess(ChatRecoveryProcessConfigSchema.parse(JSON.parse(childConfig)));
} else {
  const cases = [
    { operationKind: 'message', barrier: 'submission', force: false },
    { operationKind: 'message', barrier: 'text', force: false },
    { operationKind: 'message', barrier: 'projection', force: false },
    { operationKind: 'message', barrier: 'terminal', force: false },
    { operationKind: 'plan', barrier: 'result', force: false },
    { operationKind: 'repo-search', barrier: 'result', force: false },
    { operationKind: 'repo-agent', barrier: 'proposal', force: false },
    { operationKind: 'repo-agent', barrier: 'approval', force: false },
    { operationKind: 'repo-agent', barrier: 'start', force: false },
    { operationKind: 'repo-agent', barrier: 'effect', force: false },
    { operationKind: 'repo-agent', barrier: 'result', force: false },
    { operationKind: 'repo-agent', barrier: 'finalization', force: false },
    { operationKind: 'repo-agent', barrier: 'coalescing_before', force: false },
    { operationKind: 'repo-agent', barrier: 'coalescing_after', force: false },
    { operationKind: 'repo-agent', barrier: 'finalization_mixed', force: false },
    { operationKind: 'message', barrier: 'invalid_rejection', force: false },
    { operationKind: 'condense', barrier: 'deletion', force: false },
    { operationKind: 'condense', barrier: 'replacement', force: false },
    { operationKind: 'repo-agent', barrier: 'replacement', force: false },
    { operationKind: 'repo-agent', barrier: 'queue', force: false },
    { operationKind: 'condense', barrier: 'submission', force: false },
    { operationKind: 'condense', barrier: 'terminal', force: false },
    { operationKind: 'repo-agent', barrier: 'queue', force: true },
  ] satisfies { operationKind: ChatSessionOperationKind; barrier: z.infer<typeof ChatRecoveryBarrierSchema>; force: boolean }[];

  for (const scenario of cases) test(`hard crash: ${scenario.operationKind}/${scenario.barrier}${scenario.force ? '/force' : ''}`, { timeout: 60_000 }, async t => {
    const root = createManagedTempDir('chat-hard-crash-');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'siftkit', type: 'module' }));
    writeFileSync(join(root, 'evidence.txt'), `${'evidence '.repeat(80)}CRASH_TOOL_FULL_OUTPUT_116`);
    writeFileSync(join(root, 'effect.ts'), "import { appendFileSync } from 'node:fs';\nappendFileSync('effects.txt', 'effect\\n');\nprocess.stdout.write('" + 'evidence '.repeat(80) + "CRASH_TOOL_FULL_OUTPUT_116');\n");
    const retainedImageReplacement = scenario.operationKind === 'repo-agent' && scenario.barrier === 'replacement';
    const backend = new GatedChatBackend(retainedImageReplacement ? { overflowTokenText: 'CRASH_TOOL_FULL_OUTPUT_116' } : {});
    const providerUrl = await backend.start();
    const processConfig = ChatRecoveryProcessConfigSchema.parse({ root, providerUrl, barrier: scenario.barrier,
      operationKind: scenario.operationKind, clockAdvanceMs: 0 });
    const child = new ChatRecoveryProcess(fileURLToPath(import.meta.url), processConfig);
    let replacement: ChatRecoveryProcess | null = null;
    let closing = false;
    let continuing = false;
    let originalResponses = 0;
    let deletionRequested = false;
    let pump: Promise<void> | null = null;
    const image = toDataUrl('image/png', rasterBuffer('png', 1, 1));
    t.after(async () => {
      closing = true;
      await child.kill();
      await replacement?.kill();
      await backend.close();
      await pump;
      assert.equal(await removeDirectoryWithRetries(root), true);
    });
    const baseUrl = await child.ready();
    const sessionUrl = `${baseUrl}/dashboard/chat/sessions/crash-session`;
    const toolBarrier = (['proposal', 'approval', 'start', 'effect', 'result', 'finalization', 'coalescing_before', 'coalescing_after', 'finalization_mixed', 'invalid_rejection', 'queue'].includes(scenario.barrier)
      || retainedImageReplacement) && !scenario.force;
    const repeatedToolBarrier = ['coalescing_before', 'coalescing_after', 'finalization_mixed'].includes(scenario.barrier);
    const deleteCapturedImage = async (): Promise<void> => {
      if (deletionRequested) return;
      deletionRequested = true;
      const sessionResponse = ChatSessionResponseSchema.parse((await requestJson(sessionUrl)).body);
      const imageMessage = sessionResponse.session.messages.find(message => (message.images?.length ?? 0) > 0);
      if (!imageMessage) throw new Error('Deletion barrier did not find the admitted image.');
      const deleted = await requestJson(`${sessionUrl}/messages/${imageMessage.id}/images/0`, { method: 'DELETE' });
      assert.equal(deleted.statusCode, 200);
    };
    pump = (async () => {
      try {
        while (!closing) {
          const response = await backend.nextRequest();
          if (closing) return;
          const shouldSendTool = !continuing && toolBarrier && (repeatedToolBarrier ? originalResponses < 3 : originalResponses === 0);
          if (shouldSendTool) {
            const responseNumber = originalResponses++;
            if (scenario.barrier === 'queue' && responseNumber === 0) {
              const enqueued = await requestJson(`${sessionUrl}/queue`, { method: 'POST', body: JSON.stringify({
                id: randomUUID(), content: 'CRASH_STEERING_41', images: [], options: { operationKind: scenario.operationKind },
              }) });
              assert.equal(enqueued.statusCode, 200);
            }
            const name = scenario.operationKind === 'repo-agent' ? 'run' : 'read';
            const args = scenario.barrier === 'invalid_rejection'
              ? {}
              : name === 'run' ? { command: 'node --experimental-strip-types effect.ts' } : { path: 'evidence.txt' };
            const calls = scenario.barrier === 'finalization_mixed' && responseNumber === 2
              ? [
                { index: 0, id: 'native-crash-call-duplicate', type: 'function', function: { name, arguments: JSON.stringify(args) } },
                { index: 1, id: 'native-crash-call-fresh', type: 'function', function: { name, arguments: JSON.stringify({ command: 'Write-Output fresh' }) } },
              ]
              : [{ index: 0, id: `native-crash-call-${String(responseNumber)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }];
            backend.write(response, { tool_calls: calls });
            backend.finish(response);
          } else if (!continuing && (scenario.barrier === 'text' || scenario.barrier === 'projection')) {
            backend.write(response, { content: 'CRASH_PARTIAL_21 '.repeat(300) });
          } else {
            const isCompactionSummary = !continuing && !deletionRequested
              && (scenario.operationKind === 'condense' || retainedImageReplacement);
            if (!continuing && !deletionRequested && (scenario.barrier === 'deletion' || scenario.barrier === 'replacement')) {
              await deleteCapturedImage();
            }
            backend.write(response, { content: isCompactionSummary
              ? 'CRASH_COMPACTION_SUMMARY CRASH_PRIOR_17' : 'Final answer after recovery' });
            backend.finish(response);
          }
        }
      } catch (error) { if (!closing) throw error; }
    })();

    const body = { operationId: randomUUID(), content: 'CRASH_ORIGINAL_42', images: [image], repoRoot: root,
      maxTurns: 4, approval: scenario.barrier === 'approval' ? 'interactive' : 'off' };
    if (scenario.force) {
      for (const content of ['CRASH_ORIGINAL_42', 'CRASH_STEERING_41']) {
        const enqueued = await requestJson(`${sessionUrl}/queue`, { method: 'POST', body: JSON.stringify({
          id: randomUUID(), content, images: content === 'CRASH_ORIGINAL_42' ? [image] : [],
          options: { operationKind: scenario.operationKind, repoRoot: root, approval: 'off', maxTurns: 4 },
        }) });
        assert.equal(enqueued.statusCode, 200);
      }
    }
    const submitted = scenario.force
      ? requestJson(`${sessionUrl}/queue/force`, { method: 'POST', body: JSON.stringify({ id: randomUUID(), operationId: null }) }).catch(toError)
      : scenario.operationKind === 'condense'
        ? requestJson(`${sessionUrl}/condense`, { method: 'POST', body: '{}' }).catch(toError)
        : requestSse(`${sessionUrl}/${scenario.operationKind === 'message' ? 'messages' : scenario.operationKind}/stream`, {
        method: 'POST', body: JSON.stringify(body), timeoutMs: 30_000,
      }).catch(toError);
    const barrier = await child.barrier();
    await child.kill();
    await submitted;
    assert.equal(existsSync(join(root, 'clean-shutdown.txt')), false, 'hard termination must bypass cleanup handlers');
    const effects = (): number => existsSync(join(root, 'effects.txt'))
      ? z.array(z.literal('effect')).parse(readFileSync(join(root, 'effects.txt'), 'utf8').trim().split('\n')).length : 0;
    const effectCount = effects();
    if (scenario.operationKind === 'repo-agent' && (['effect', 'result', 'finalization', 'coalescing_before', 'coalescing_after', 'finalization_mixed', 'queue'].includes(scenario.barrier)
      || retainedImageReplacement) && !scenario.force) assert.equal(effectCount, 1);
    else assert.equal(effectCount, 0);
    if (retainedImageReplacement) {
      const imageRequests = backend.requests.filter(request => JSON.stringify(request.messages).includes(image));
      assert.equal(imageRequests.length >= 2, true, 'the in-flight compaction request must carry the captured image');
    }
    const requestCount = backend.requests.length;
    replacement = new ChatRecoveryProcess(fileURLToPath(import.meta.url), { ...processConfig, barrier: 'none', clockAdvanceMs: CHAT_OWNER_LEASE_MS + 1 });
    const recoveredUrl = `${await replacement.ready()}/dashboard/chat/sessions/crash-session`;
    const recoveredResponse = await requestJson(recoveredUrl);
    assert.equal(recoveredResponse.statusCode, 200);
    const recovered = ChatSessionResponseSchema.parse(recoveredResponse.body);
    assert.equal(recovered.recovery?.some(report => report.status === 'recovery_failed'), false);
    assert.equal(new Set(recovered.session.messages.map(message => message.id)).size, recovered.session.messages.length);
    assert.equal(backend.requests.length, requestCount, 'recovery must make no provider request');
    assert.equal(effects(), effectCount, 'recovery must not repeat an external effect');
    const database = new Database(join(root, '.siftkit', 'runtime.sqlite'), { readonly: true });
    try {
      const journal = new ChatJournalStore(database);
      const events = [...journal.readAll(barrier.operationId)];
      const run = journal.readRun(barrier.operationId);
      assert.equal(run?.terminalCause, scenario.barrier === 'terminal' ? 'completed' : 'server_restart');
      if (scenario.barrier === 'coalescing_before' || scenario.barrier === 'coalescing_after') {
        const coalescing = events.flatMap((envelope) => envelope.event.kind === 'context_spliced' && envelope.event.coalescedToolCallIds.length > 0 ? [envelope] : []);
        assert.equal(coalescing.length, scenario.barrier === 'coalescing_after' ? 1 : 0);
      }
      if (scenario.barrier === 'finalization_mixed') {
        assert.equal(events.filter(envelope => envelope.event.kind === 'tool_proposed' && envelope.event.call.indexInBatch === 1).length, 1);
        assert.equal(events.filter(envelope => envelope.event.kind === 'tool_result_finalized').length > 0, true);
      }
      if (retainedImageReplacement) {
        const replacements = events.filter(envelope => envelope.event.kind === 'context_spliced' && envelope.event.reason === 'compacted');
        assert.equal(replacements.length, 1);
        assert.equal(JSON.stringify(replacements).includes(image), false, 'a deleted image must not enter the committed replacement');
      }
      const tools = recovered.session.messages.filter(message => message.sourceRunId === barrier.operationId && message.kind === 'assistant_tool_call');
      if (toolBarrier) {
        const expectedToolCount = scenario.barrier === 'finalization_mixed' ? 4 : repeatedToolBarrier ? 3 : 1;
        assert.equal(tools.length, expectedToolCount);
        assert.equal(tools[0]?.toolCallExecutionState, scenario.barrier === 'invalid_rejection' ? 'rejected'
          : ['proposal', 'approval'].includes(scenario.barrier) ? 'not_started'
            : ['start', 'effect'].includes(scenario.barrier) ? 'uncertain' : 'completed');
      }
    } finally { database.close(); }
    if (scenario.barrier === 'queue') {
      const queue = ChatMessageQueueResponseSchema.parse((await requestJson(`${recoveredUrl}/queue`)).body).queue;
      assert.equal(queue.paused, true);
    }

    continuing = true;
    const continuationKind = scenario.operationKind === 'condense' ? 'message' : scenario.operationKind;
    const response = await requestSse(`${recoveredUrl}/${continuationKind === 'message' ? 'messages' : continuationKind}/stream`, {
      method: 'POST', timeoutMs: 30_000, body: JSON.stringify({ operationId: randomUUID(), content: 'CRASH_CONTINUE_99', repoRoot: root, maxTurns: 4, approval: 'off' }),
    });
    assert.equal(response.statusCode, 200);
    assert.equal(readChatStream(response, 'crash-session').terminal?.terminalCause, 'completed', JSON.stringify(response.events.at(-1)));
    const captured = backend.requests.slice(requestCount).find(request => request.messages.some(message => messageText(message.content).includes('CRASH_CONTINUE_99')));
    assert.ok(captured, 'expected a captured continuation provider request');
    const history = PlannerChatMessagesSchema.parse(captured.messages);
    assert.equal(findPlannerContextViolation(history), null);
    const texts = captured.messages.map(message => messageText(message.content));
    assert.equal(texts.filter(text => text.includes('CRASH_CONTINUE_99')).length, 1);
    assert.equal(texts.filter(text => text.includes('CRASH_PRIOR_17')).length, 1);
    if (scenario.operationKind !== 'condense') assert.equal(texts.filter(text => text.includes('CRASH_ORIGINAL_42')).length, 1);
    if (scenario.barrier === 'queue') assert.equal(texts.filter(text => text.includes('CRASH_STEERING_41')).length, 1);
    if (scenario.barrier === 'deletion' || scenario.barrier === 'replacement') assert.equal(JSON.stringify(captured.messages).includes(image), false);
    if (retainedImageReplacement) assert.equal(recovered.session.messages.some(message => message.images?.includes(image) === true), false);
    if (toolBarrier && ['result', 'queue'].includes(scenario.barrier)) assert.ok(texts.some(text => text.includes('CRASH_TOOL_FULL_OUTPUT_116')));
    assert.equal(effects(), effectCount);
  });
}
