import type { InferenceBackendId } from '../config/types.js';
import { StatusServerApiClient } from './status-server-api-client.js';

export type RunBackendOptions = {
  argv: string[];
  stdout: NodeJS.WritableStream;
};

function writeStatus(stdout: NodeJS.WritableStream, value: object): void {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function runBackend(options: RunBackendOptions): Promise<number> {
  const action = options.argv[1];
  const client = new StatusServerApiClient();
  if (action === 'status') {
    writeStatus(options.stdout, await client.getBackendStatus());
    return 0;
  }
  if (action === 'use') {
    const backendValue = options.argv[2];
    const backend: InferenceBackendId | null = backendValue === 'llama' || backendValue === 'exl3'
      ? backendValue
      : null;
    if (!backend) {
      throw new Error('Usage: siftkit backend use <llama|exl3> [--wait]');
    }
    const response = await client.selectBackend({
      backend,
      wait: options.argv.includes('--wait'),
    });
    writeStatus(options.stdout, response);
    return response.outcome === 'failed' ? 1 : 0;
  }
  throw new Error('Supported backend commands: siftkit backend status; siftkit backend use <llama|exl3> [--wait]');
}
