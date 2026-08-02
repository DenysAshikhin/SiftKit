import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';

import { Exl3LoadRequestSchema } from '../../src/inference-presets/exl3-preset-adapter.js';

/**
 * Models TabbyAPI's `/v1/model` card: a loaded server reports the parameters it actually applied,
 * so a fake that echoes the load request proves the runtime verifies what it asked for.
 */
export class FakeTabbyModelState {
  private card: {
    id: string;
    parameters: { max_seq_len: number; cache_size: number; chunk_size: number };
  } | null = null;

  applyLoad(bodyText: string): void {
    const request = Exl3LoadRequestSchema.parse(JSON.parse(bodyText));
    this.card = {
      id: request.model_name,
      parameters: {
        max_seq_len: request.max_seq_len,
        cache_size: request.cache_size,
        chunk_size: request.chunk_size,
      },
    };
  }

  applyResidentModel(id: string, maxSeqLen: number, cacheSize: number, chunkSize: number): void {
    this.card = { id, parameters: { max_seq_len: maxSeqLen, cache_size: cacheSize, chunk_size: chunkSize } };
  }

  clear(): void {
    this.card = null;
  }

  get resident(): boolean {
    return this.card !== null;
  }

  respondCurrentModel(response: http.ServerResponse): void {
    if (this.card === null) {
      response.statusCode = 503;
      response.end('No models are currently loaded');
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(this.card));
  }
}

export interface FakeTabbyFiles {
  scriptPath: string;
  pythonPath: string;
  argsPath: string;
  environmentPath: string;
  loadRequestsPath: string;
  startsPath: string;
}

export interface FakeExl3Venv {
  pythonPath: string;
  jobSourcePath: string;
}

const DEVICE_RESIDENT_JOB_SOURCE = `
    def prepare_sampling_past_ids(self):
        n = len(self.sequences[0].sequence_ids)
        if self.pinned_ids_valid < n:
            self.pinned_ids_valid = n
`;

const LEGACY_JOB_SOURCE = `
    def prepare_sampling_past_ids(self):
        n = len(self.sequences[0].sequence_ids)
        self.pinned_ids[:, :n].copy_(self.sequences[0].sequence_ids.torch())
`;

/**
 * Windows venv layout the EXL3 preflight reads: `<venv>\\Scripts\\<interpreter>` alongside
 * `<venv>\\Lib\\site-packages\\exllamav3\\generator\\job.py`. The interpreter is a hard link to
 * the running Node binary so the fake TabbyAPI script is actually launchable from the venv path;
 * `deviceResidentPastIds` selects an exllamav3 with or without turboderp-org/exllamav3@8e08af9.
 */
export function writeFakeExl3Venv(root: string, deviceResidentPastIds: boolean): FakeExl3Venv {
  const venvRoot = path.join(root, 'venv');
  const scriptsDirectory = path.join(venvRoot, 'Scripts');
  const generatorDirectory = path.join(venvRoot, 'Lib', 'site-packages', 'exllamav3', 'generator');
  fs.mkdirSync(scriptsDirectory, { recursive: true });
  fs.mkdirSync(generatorDirectory, { recursive: true });
  const pythonPath = path.join(scriptsDirectory, path.basename(process.execPath));
  if (!fs.existsSync(pythonPath)) {
    try {
      fs.linkSync(process.execPath, pythonPath);
    } catch {
      fs.copyFileSync(process.execPath, pythonPath);
    }
  }
  const jobSourcePath = path.join(generatorDirectory, 'job.py');
  fs.writeFileSync(jobSourcePath, deviceResidentPastIds ? DEVICE_RESIDENT_JOB_SOURCE : LEGACY_JOB_SOURCE, 'utf8');
  return { pythonPath, jobSourcePath };
}

/**
 * Fake TabbyAPI that reports the model card its launch environment produced, so the runtime's
 * resident-parameter verification is exercised end to end. `appliedMaxSeqLen` simulates a server
 * that silently clamps the requested context. `draftingStream` selects where the MTP line lands:
 * real TabbyAPI logs through loguru, which writes to stderr by default.
 */
export function writeFakeTabby(
  root: string,
  port: number,
  appliedMaxSeqLen: number | null,
  options: { announceDrafting?: boolean; draftingStream?: 'stdout' | 'stderr' } = {},
): FakeTabbyFiles {
  const announceDrafting = options.announceDrafting ?? true;
  const draftingStream = options.draftingStream ?? 'stdout';
  const files: FakeTabbyFiles = {
    scriptPath: path.join(root, 'fake-tabby.cjs'),
    pythonPath: writeFakeExl3Venv(root, true).pythonPath,
    argsPath: path.join(root, 'args.json'),
    environmentPath: path.join(root, 'environment.json'),
    loadRequestsPath: path.join(root, 'load-requests.txt'),
    startsPath: path.join(root, 'starts.txt'),
  };
  fs.writeFileSync(files.scriptPath, `
const fs = require('node:fs');
const http = require('node:http');
fs.writeFileSync(${JSON.stringify(files.argsPath)}, JSON.stringify(process.argv.slice(2)));
fs.appendFileSync(${JSON.stringify(files.startsPath)}, process.pid + '\\n');
const environment = Object.fromEntries(Object.entries(process.env).filter(
  ([key]) => key.startsWith('TABBY_') || key.startsWith('EXL3_'),
));
fs.writeFileSync(${JSON.stringify(files.environmentPath)}, JSON.stringify(environment));
if (${JSON.stringify(announceDrafting)} && environment.TABBY_DRAFT_MODEL_DRAFT_MODE === 'mtp') {
  process.${draftingStream}.write('INFO: Using main model MTP component for drafting\\n');
}
const card = environment.TABBY_MODEL_MODEL_NAME ? {
  id: environment.TABBY_MODEL_MODEL_NAME,
  parameters: {
    max_seq_len: ${appliedMaxSeqLen === null ? 'Number(environment.TABBY_MODEL_MAX_SEQ_LEN)' : String(appliedMaxSeqLen)},
    cache_size: Number(environment.TABBY_MODEL_CACHE_SIZE),
    chunk_size: Number(environment.TABBY_MODEL_CHUNK_SIZE),
  },
} : null;
const server = http.createServer((request, response) => {
  if (request.url === '/v1/model/load' && request.method === 'POST') {
    fs.appendFileSync(${JSON.stringify(files.loadRequestsPath)}, 'load\\n');
    response.statusCode = 500;
    response.end();
    return;
  }
  if (request.url === '/v1/model' && request.method === 'GET') {
    if (!card) {
      response.statusCode = 503;
      response.end('No models are currently loaded');
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(card));
    return;
  }
  response.setHeader('content-type', 'application/json');
  response.end('{"object":"list","data":[]}');
});
server.listen(${port}, '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`, 'utf8');
  return files;
}
