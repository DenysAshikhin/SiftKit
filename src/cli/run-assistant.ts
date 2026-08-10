import type { JsonValue } from '../lib/json-types.js';
import type { ObjectValueType } from '../assistant/domain/enums.js';
import { parseAssistantArgs } from './assistant-args.js';
import { StatusServerApiClient } from './status-server-api-client.js';

interface RunAssistantOptions {
  readonly args: readonly string[];
  readonly stdout: NodeJS.WritableStream;
  readonly client?: StatusServerApiClient;
}

function writeJson<T>(stdout: NodeJS.WritableStream, value: T): void {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function literalType(value: JsonValue): ObjectValueType {
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return 'json';
}

export async function runAssistantCli(options: RunAssistantOptions): Promise<number> {
  const invocation = parseAssistantArgs(options.args);
  const client = options.client ?? new StatusServerApiClient();
  const token = await client.bootstrapAssistantToken();
  switch (invocation.kind) {
    case 'status':
      writeJson(options.stdout, await client.requestAssistantStatus(token));
      return 0;
    case 'pause':
    case 'resume': {
      const current = await client.requestAssistantConfig(token);
      await client.patchAssistantConfig(token, {
        ...current.assistant,
        Enabled: invocation.kind === 'resume',
      });
      options.stdout.write(`assistant ${invocation.kind === 'resume' ? 'resumed' : 'paused'}\n`);
      return 0;
    }
    case 'memory_search':
      writeJson(options.stdout, await client.searchAssistantMemory(
        token, invocation.query, invocation.modelIntent,
      ));
      return 0;
    case 'memory_explain':
      writeJson(options.stdout, await client.explainAssistantAssertion(token, invocation.assertionId));
      return 0;
    case 'memory_confirm':
      await client.mutateAssistantAssertion(token, invocation.assertionId, 'confirm', {
        reason: 'Confirmed through the SiftKit assistant CLI.',
      });
      options.stdout.write('memory confirmed\n');
      return 0;
    case 'memory_correct': {
      const objectText = typeof invocation.value === 'string'
        ? invocation.value
        : JSON.stringify(invocation.value);
      await client.mutateAssistantAssertion(token, invocation.assertionId, 'correct', {
        reason: 'Corrected through the SiftKit assistant CLI.',
        object: {
          kind: 'literal', valueType: literalType(invocation.value), value: invocation.value,
        },
        objectText,
      });
      options.stdout.write('memory corrected\n');
      return 0;
    }
    case 'memory_forget_preview':
      writeJson(options.stdout, await client.previewAssistantForget(
        token, invocation.assertionId,
      ));
      return 0;
    case 'memory_forget_confirm':
      await client.confirmAssistantForget(token, invocation.assertionId, invocation.previewToken);
      options.stdout.write('memory forgotten\n');
      return 0;
    case 'policy_list':
      writeJson(options.stdout, await client.listAssistantPolicies(token));
      return 0;
    case 'policy_block_topic':
      await client.blockAssistantPolicyTopic(token, invocation.topic);
      options.stdout.write('topic blocked\n');
      return 0;
    case 'projections_rebuild':
      await client.rebuildAssistantProjections(token);
      options.stdout.write('projections rebuilt\n');
      return 0;
  }
}
