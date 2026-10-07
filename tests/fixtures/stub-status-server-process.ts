// Runs the node suite's stub status server as a process, so the Pester suite drives the same double.
import { extractPromptSection, startStubStatusServer } from '../_runtime-helpers.ts';

// The model echoes its input, so a caller can see exactly what text reached it.
const server = await startStubStatusServer({
  chatDelayMs: Number(process.env.SIFTKIT_TEST_CHAT_DELAY_MS ?? '0'),
  tokenizeTokenCount: (content) => Math.ceil(String(content).length / 4),
  assistantContent: (promptText) => JSON.stringify({
    classification: 'summary', raw_review_required: false, output: extractPromptSection(promptText, 'Input:'),
  }),
});
// The stub summarizes in-process, so its own config and status calls must reach itself, as withStubServer arranges.
process.env.SIFTKIT_STATUS_BACKEND_URL = server.statusUrl;
process.env.SIFTKIT_CONFIG_SERVICE_URL = server.configUrl;
process.stdout.write(`${JSON.stringify({ port: server.port })}\n`);
