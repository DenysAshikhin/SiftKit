import fs from 'node:fs';

import { parseAssistantArgs } from './assistant-args.ts';
import { StatusServerApiClient } from './status-server-api-client.ts';

interface RunAssistantOptions {
  readonly args: readonly string[];
  readonly stdout: NodeJS.WritableStream;
  readonly client?: StatusServerApiClient;
}

function writeJson<T>(stdout: NodeJS.WritableStream, value: T): void {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeArchive(stdout: NodeJS.WritableStream, output: string, bytes: Buffer): void {
  fs.writeFileSync(output, bytes);
  stdout.write(`wrote ${output} (${bytes.byteLength} bytes)\n`);
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
    case 'factory_reset_preview':
      writeJson(options.stdout, await client.previewAssistantFactoryReset(token));
      return 0;
    case 'factory_reset_confirm':
      await client.confirmAssistantFactoryReset(token, invocation.previewToken);
      options.stdout.write('assistant reset\n');
      return 0;
    case 'export':
      writeArchive(options.stdout, invocation.output, await client.requestAssistantZip(
        '/assistant/export', token, { includeDecryptedBlobs: invocation.includeBlobs },
      ));
      return 0;
    case 'backup':
      writeArchive(
        options.stdout, invocation.output,
        await client.requestAssistantZip('/assistant/backup', token),
      );
      return 0;
    case 'restore_preview':
      writeJson(options.stdout, await client.postAssistantRestorePreview(
        token, fs.readFileSync(invocation.input),
      ));
      return 0;
    case 'restore_confirm': {
      const result = await client.confirmAssistantRestore(
        token, invocation.uploadId, invocation.confirmToken,
      );
      options.stdout.write(`assistant restored (blobsReadable=${result.blobsReadable})\n`);
      // A backup sealed on another machine restores with unreadable blobs; never let that pass
      // as a plain success line (spec §16.4).
      if (result.warning !== null) options.stdout.write(`${result.warning}\n`);
      return 0;
    }
  }
}
