import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';

import { parseAssistantArgs } from '../src/cli/assistant-args.ts';
import { runAssistantCli } from '../src/cli/run-assistant.ts';
import { StatusServerApiClient } from '../src/cli/status-server-api-client.ts';
import {
  HttpClient,
  type RequestBytesOptions,
  type RequestJsonOptions,
} from '../src/lib/http-client.ts';
import type { JsonValue } from '../src/lib/json-types.ts';
import type { z } from '../src/lib/zod.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

const ZIP_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02, 0x03]);

const RESTORE_PREVIEW = {
  uploadId: 'upl_1',
  confirmToken: 'cft_1',
  schemaVersion: 44,
  custody: 'file',
  fileCount: 7,
  totalBytes: 4096,
} as const;

const JSON_RESPONSES: ReadonlyMap<string, JsonValue> = new Map<string, JsonValue>([
  ['GET /assistant/auth/bootstrap', { token: 'tok_1' }],
  ['GET /assistant/factory-reset/preview', {
    previewToken: 'pre_reset',
    graphVersion: 6,
    tableCounts: { assistant_assertions: 12 },
    blobCount: 3,
    blobBytes: 2048,
  }],
  ['POST /assistant/factory-reset', { ok: true }],
  ['POST /assistant/restore', {
    ok: true,
    blobsReadable: false,
    warning: 'Blobs were sealed on another machine.',
  }],
]);

class RecordingHttpClient extends HttpClient {
  readonly jsonRequests: RequestJsonOptions[] = [];
  readonly byteRequests: RequestBytesOptions[] = [];

  override requestJson<T>(options: RequestJsonOptions, schema: z.ZodType<T>): Promise<T> {
    this.jsonRequests.push(options);
    const payload = JSON_RESPONSES.get(this.key(options.method, options.url));
    if (payload === undefined) {
      return Promise.reject(new Error(`Unexpected JSON request: ${options.method} ${options.url}`));
    }
    return Promise.resolve(schema.parse(payload));
  }

  override requestBytes(options: RequestBytesOptions): Promise<Buffer> {
    this.byteRequests.push(options);
    const pathname = new URL(options.url).pathname;
    if (pathname === '/assistant/restore-preview') {
      return Promise.resolve(Buffer.from(JSON.stringify(RESTORE_PREVIEW), 'utf8'));
    }
    if (pathname === '/assistant/export' || pathname === '/assistant/backup') {
      return Promise.resolve(ZIP_BYTES);
    }
    return Promise.reject(new Error(`Unexpected byte request: ${options.method} ${options.url}`));
  }

  private key(method: string, url: string): string {
    return `${method} ${new URL(url).pathname}`;
  }
}

class StdoutSink extends Writable {
  private text = '';

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    done: (error?: Error | null) => void,
  ): void {
    this.text += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    done();
  }

  get output(): string {
    return this.text;
  }
}

async function run(args: readonly string[]): Promise<{
  readonly stdout: string;
  readonly http: RecordingHttpClient;
  readonly exitCode: number;
}> {
  const http = new RecordingHttpClient();
  const stdout = new StdoutSink();
  const exitCode = await runAssistantCli({
    args, stdout, client: new StatusServerApiClient(http),
  });
  return { stdout: stdout.output, http, exitCode };
}

test('assistant CLI parses every Gate E command exactly', () => {
  assert.deepEqual(parseAssistantArgs(['factory-reset', '--preview']), {
    kind: 'factory_reset_preview',
  });
  assert.deepEqual(parseAssistantArgs(['factory-reset', '--confirm', 'pre_reset']), {
    kind: 'factory_reset_confirm', previewToken: 'pre_reset',
  });
  assert.deepEqual(parseAssistantArgs(['export', '--output', 'x.zip']), {
    kind: 'export', output: 'x.zip', includeBlobs: false,
  });
  assert.deepEqual(parseAssistantArgs(['export', '--output', 'x.zip', '--include-blobs']), {
    kind: 'export', output: 'x.zip', includeBlobs: true,
  });
  assert.deepEqual(parseAssistantArgs(['backup', '--output', 'x.zip']), {
    kind: 'backup', output: 'x.zip',
  });
  assert.deepEqual(parseAssistantArgs(['restore', '--input', 'x.zip', '--preview']), {
    kind: 'restore_preview', input: 'x.zip',
  });
  assert.deepEqual(parseAssistantArgs(['restore', '--confirm', 'upl_1', 'cft_1']), {
    kind: 'restore_confirm', uploadId: 'upl_1', confirmToken: 'cft_1',
  });
});

test('assistant CLI rejects malformed Gate E invocations with their usage strings', () => {
  const cases: readonly (readonly [readonly string[], RegExp])[] = [
    [['factory-reset'], /exactly one of --preview or --confirm <token>/u],
    [['factory-reset', '--confirm'], /exactly one of --preview or --confirm <token>/u],
    [['export'], /Usage: siftkit assistant export --output <path> \[--include-blobs\]/u],
    [['export', 'x.zip'], /Usage: siftkit assistant export --output <path> \[--include-blobs\]/u],
    [['backup'], /Usage: siftkit assistant backup --output <path>/u],
    [['backup', '--out', 'x.zip'], /Usage: siftkit assistant backup --output <path>/u],
    [['restore'], /Usage: siftkit assistant restore --input <path> --preview/u],
    [['restore', '--input', 'x.zip'], /Usage: siftkit assistant restore --input <path> --preview/u],
    [
      ['restore', '--confirm', 'upl_1'],
      /Usage: siftkit assistant restore --input <path> --preview/u,
    ],
  ];
  for (const [args, message] of cases) {
    assert.throws(() => parseAssistantArgs(args), message, args.join(' '));
  }
});

test('factory reset previews the table counts before the confirm token is spent', async () => {
  const preview = await run(['factory-reset', '--preview']);
  assert.deepEqual(JSON.parse(preview.stdout), {
    previewToken: 'pre_reset',
    graphVersion: 6,
    tableCounts: { assistant_assertions: 12 },
    blobCount: 3,
    blobBytes: 2048,
  });
  assert.equal(preview.http.jsonRequests[1]?.method, 'GET');

  const confirm = await run(['factory-reset', '--confirm', 'pre_reset']);
  assert.equal(confirm.stdout, 'assistant reset\n');
  assert.equal(confirm.http.jsonRequests[1]?.method, 'POST');
  assert.deepEqual(JSON.parse(confirm.http.jsonRequests[1]?.body ?? '{}'), {
    previewToken: 'pre_reset',
  });
});

test('export and backup write the archive bytes to disk unchanged', async () => {
  const directory = createManagedTempDir('siftkit-gate-e-cli-');
  const exportPath = path.join(directory, 'export.zip');
  const backupPath = path.join(directory, 'backup.zip');

  const exported = await run(['export', '--output', exportPath, '--include-blobs']);
  assert.equal(exported.stdout, `wrote ${exportPath} (${ZIP_BYTES.length} bytes)\n`);
  assert.deepEqual(fs.readFileSync(exportPath), ZIP_BYTES);
  const exportRequest = exported.http.byteRequests[0];
  assert.equal(exportRequest?.method, 'POST');
  assert.match(exportRequest?.url ?? '', /\/assistant\/export$/u);
  assert.deepEqual(
    JSON.parse((exportRequest?.body ?? Buffer.alloc(0)).toString('utf8')),
    { includeDecryptedBlobs: true },
  );

  const backedUp = await run(['backup', '--output', backupPath]);
  assert.equal(backedUp.stdout, `wrote ${backupPath} (${ZIP_BYTES.length} bytes)\n`);
  assert.deepEqual(fs.readFileSync(backupPath), ZIP_BYTES);
  assert.match(backedUp.http.byteRequests[0]?.url ?? '', /\/assistant\/backup$/u);
});

test('restore uploads the archive bytes and reports unreadable blobs loudly', async () => {
  const directory = createManagedTempDir('siftkit-gate-e-cli-');
  const archivePath = path.join(directory, 'restore.zip');
  fs.writeFileSync(archivePath, ZIP_BYTES);

  const preview = await run(['restore', '--input', archivePath, '--preview']);
  assert.deepEqual(JSON.parse(preview.stdout), RESTORE_PREVIEW);
  const uploadRequest = preview.http.byteRequests[0];
  assert.equal(uploadRequest?.method, 'POST');
  assert.match(uploadRequest?.url ?? '', /\/assistant\/restore-preview$/u);
  assert.deepEqual(uploadRequest?.body, ZIP_BYTES);
  assert.equal(uploadRequest?.headers?.['Content-Type'], 'application/zip');
  assert.equal(uploadRequest?.headers?.Authorization, 'Bearer tok_1');

  const confirm = await run(['restore', '--confirm', 'upl_1', 'cft_1']);
  assert.equal(
    confirm.stdout,
    'assistant restored (blobsReadable=false)\nBlobs were sealed on another machine.\n',
  );
  assert.deepEqual(JSON.parse(confirm.http.jsonRequests[1]?.body ?? '{}'), {
    uploadId: 'upl_1', confirmToken: 'cft_1',
  });
});
