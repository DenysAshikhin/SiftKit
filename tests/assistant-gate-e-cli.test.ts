import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';

import { parseAssistantArgs } from '../src/cli/assistant-args.js';
import { runAssistantCli } from '../src/cli/run-assistant.js';
import { StatusServerApiClient } from '../src/cli/status-server-api-client.js';
import {
  HttpClient,
  type RequestBytesOptions,
  type RequestJsonOptions,
} from '../src/lib/http-client.js';
import type { JsonValue } from '../src/lib/json-types.js';
import type { z } from '../src/lib/zod.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

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
  ['GET /assistant/evidence/ev_1/deletion-preview', {
    previewToken: 'pre_ev',
    graphVersion: 4,
    targetEvidenceId: 'ev_1',
    dependentAssertionIds: ['ast_1', 'ast_2'],
    affectedProjectionIds: ['proj_1'],
  }],
  ['DELETE /assistant/evidence/ev_1', { ok: true, graphVersion: 5 }],
  ['POST /assistant/topics/forget-preview', {
    previewToken: 'pre_topic',
    graphVersion: 5,
    topicKey: 'finance',
    assertionIds: ['ast_3'],
    affectedProjectionIds: ['proj_2'],
  }],
  ['POST /assistant/topics/forget', { ok: true, graphVersion: 6 }],
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
  assert.deepEqual(parseAssistantArgs(['evidence', 'delete', 'ev_1', '--preview']), {
    kind: 'evidence_delete_preview', evidenceId: 'ev_1',
  });
  assert.deepEqual(parseAssistantArgs(['evidence', 'delete', 'ev_1', '--confirm', 'pre_ev']), {
    kind: 'evidence_delete_confirm', evidenceId: 'ev_1', previewToken: 'pre_ev',
  });
  assert.deepEqual(parseAssistantArgs(['memory', 'forget-topic', 'finance', '--preview']), {
    kind: 'forget_topic_preview', topicKey: 'finance', addPolicy: false,
  });
  assert.deepEqual(parseAssistantArgs([
    'memory', 'forget-topic', 'finance', '--block', '--preview',
  ]), { kind: 'forget_topic_preview', topicKey: 'finance', addPolicy: true });
  assert.deepEqual(parseAssistantArgs([
    'memory', 'forget-topic', 'finance', '--block', '--confirm', 'pre_topic',
  ]), {
    kind: 'forget_topic_confirm', topicKey: 'finance', addPolicy: true, previewToken: 'pre_topic',
  });
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
    [['evidence'], /Unknown assistant evidence command\./u],
    [['evidence', 'purge', 'ev_1'], /Unknown assistant evidence command\./u],
    [['evidence', 'delete', 'ev_1'], /exactly one of --preview or --confirm <token>/u],
    [['evidence', 'delete', 'ev_1', '--confirm'], /exactly one of --preview or --confirm <token>/u],
    [
      ['evidence', 'delete', 'ev_1', '--preview', '--confirm', 'pre_ev'],
      /exactly one of --preview or --confirm <token>/u,
    ],
    [['memory', 'forget-topic', 'finance'], /exactly one of --preview or --confirm <token>/u],
    [
      ['memory', 'forget-topic', 'finance', '--confirm'],
      /exactly one of --preview or --confirm <token>/u,
    ],
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

test('evidence deletion runs preview then confirm through the maintenance routes', async () => {
  const preview = await run(['evidence', 'delete', 'ev_1', '--preview']);
  assert.equal(preview.exitCode, 0);
  assert.deepEqual(JSON.parse(preview.stdout), {
    previewToken: 'pre_ev',
    graphVersion: 4,
    targetEvidenceId: 'ev_1',
    dependentAssertionIds: ['ast_1', 'ast_2'],
    affectedProjectionIds: ['proj_1'],
  });
  const previewRequest = preview.http.jsonRequests[1];
  assert.equal(previewRequest?.method, 'GET');
  assert.match(previewRequest?.url ?? '', /\/assistant\/evidence\/ev_1\/deletion-preview$/u);
  assert.equal(previewRequest?.headers?.Authorization, 'Bearer tok_1');

  const confirm = await run(['evidence', 'delete', 'ev_1', '--confirm', 'pre_ev']);
  assert.equal(confirm.stdout, 'evidence deleted\n');
  const confirmRequest = confirm.http.jsonRequests[1];
  assert.equal(confirmRequest?.method, 'DELETE');
  assert.match(confirmRequest?.url ?? '', /\/assistant\/evidence\/ev_1$/u);
  assert.deepEqual(JSON.parse(confirmRequest?.body ?? '{}'), { previewToken: 'pre_ev' });
});

test('forget-topic carries the --block policy flag into the confirm request', async () => {
  const preview = await run(['memory', 'forget-topic', 'finance', '--preview']);
  assert.deepEqual(JSON.parse(preview.stdout), {
    previewToken: 'pre_topic',
    graphVersion: 5,
    topicKey: 'finance',
    assertionIds: ['ast_3'],
    affectedProjectionIds: ['proj_2'],
  });
  assert.deepEqual(JSON.parse(preview.http.jsonRequests[1]?.body ?? '{}'), { topicKey: 'finance' });

  const confirm = await run([
    'memory', 'forget-topic', 'finance', '--block', '--confirm', 'pre_topic',
  ]);
  assert.equal(confirm.stdout, 'topic forgotten\n');
  assert.deepEqual(JSON.parse(confirm.http.jsonRequests[1]?.body ?? '{}'), {
    topicKey: 'finance', addPolicy: true, previewToken: 'pre_topic',
  });
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
