import { readFile } from 'node:fs/promises';
import {
  getActiveInferenceBackend,
  getConfiguredLlamaBaseUrl,
  getConfiguredModel,
  loadConfig,
} from '../config/index.js';
import { InferenceBackendIdSchema } from '../config/types.js';
import { parseJsonText } from '../lib/json.js';
import { z } from '../lib/zod.js';
import {
  AutoApprovalProbeResultSchema,
  AutoApprovalReplayPayloadSchema,
  AutoApprovalVerdictProbe,
  ConfiguredApprovalVerdictModelClient,
} from '../repo-search/approval-verdict-probe.js';
import {
  allocateLlamaCppSlotId,
  DEFAULT_TIMEOUT_MS,
  resolvePlannerThinkingFlags,
} from '../repo-search/engine/task-loop-support.js';

export type AutoApprovalProbeCliOptions = {
  argv: string[];
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
};

export const AutoApprovalProbeCliOutputSchema = AutoApprovalProbeResultSchema.extend({
  backend: InferenceBackendIdSchema,
  model: z.string(),
});

function getPayloadPath(argv: string[]): string {
  if (argv.length !== 2 || argv[0] !== '--payload' || !argv[1]) {
    throw new Error(
      'Usage: npm run probe:auto-approval -- --payload <replay.json>',
    );
  }
  return argv[1];
}

export async function runAutoApprovalVerdictProbeCli(
  options: AutoApprovalProbeCliOptions,
): Promise<number> {
  try {
    const payloadPath = getPayloadPath(options.argv);
    const payloadText = await readFile(payloadPath, 'utf8');
    const payload = parseJsonText(payloadText, AutoApprovalReplayPayloadSchema);
    const config = await loadConfig({ ensure: true });
    const backend = getActiveInferenceBackend(config);
    const model = getConfiguredModel(config);
    const probe = new AutoApprovalVerdictProbe(
      new ConfiguredApprovalVerdictModelClient({
        config,
        baseUrl: getConfiguredLlamaBaseUrl(config),
        model,
        slotId: allocateLlamaCppSlotId(config),
        timeoutMs: DEFAULT_TIMEOUT_MS,
        thinking: resolvePlannerThinkingFlags(config),
      }),
    );
    const result = await probe.run(payload);
    options.stdout.write(`${JSON.stringify({ backend, model, ...result }, null, 2)}\n`);
    return 0;
  } catch (error) {
    options.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
