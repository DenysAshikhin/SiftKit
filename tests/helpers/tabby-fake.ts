import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';

import { Exl3LoadRequestSchema } from '../../src/inference-presets/exl3-preset-adapter.js';
import {
  Exl3ModelCapabilities,
  type Exl3PackageLocator,
} from '../../src/inference-presets/exl3-model-capabilities.js';

class FixedExl3PackageLocator implements Exl3PackageLocator {
  constructor(private readonly packageDirectory: string) {}

  resolvePackageDirectory(_pythonPath: string): string | null {
    return this.packageDirectory;
  }
}

export function createFakeExl3Capabilities(
  pythonPath: string,
  packageDirectory = path.join(path.dirname(path.dirname(pythonPath)), 'Lib', 'site-packages', 'exllamav3'),
): Exl3ModelCapabilities {
  return new Exl3ModelCapabilities(new FixedExl3PackageLocator(packageDirectory));
}

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
  capabilities: Exl3ModelCapabilities;
}

export interface FakeExl3Venv {
  pythonPath: string;
  jobSourcePath: string;
  frozenTensorsPath: string;
  modelSourcePath: string;
}

export interface FakeUnifiedExl3Venv extends FakeExl3Venv {
  editablePackageDirectory: string;
}

/** Selects which halves of the host-RAM freeze patch the fake exllamav3 carries. */
export interface FakeExl3FreezeSupport {
  frozenTensorSource: boolean;
  modelFreeze: boolean;
  freezeCoverage: boolean;
}

const FREEZE_MODEL_SOURCE = `
    def freeze(self) -> FrozenTensorSource:
        return FrozenTensorSource(self.get_tensors())
`;

/** Appended to `FREEZE_MODEL_SOURCE`, so the two halves of the patch cannot drift apart. */
const FREEZE_COVERAGE_SOURCE = `
    def _validate_freeze_coverage(self, tensors):
        return None
`;

const UNPATCHED_MODEL_SOURCE = `
    def unload(self):
        for module in self.modules:
            module.unload()
`;

const FROZEN_TENSORS_SOURCE = `
class FrozenTensorSource:
    def __init__(self, tensors):
        self.tensors = dict(tensors)
`;

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
 * `freezeSupport` selects each half of the host-RAM freeze patch independently so a partial
 * overlay — the exact failure mode of hand-copying files into site-packages — is representable.
 */
export function writeFakeExl3Venv(
  root: string,
  deviceResidentPastIds: boolean,
  freezeSupport: FakeExl3FreezeSupport = { frozenTensorSource: true, modelFreeze: true, freezeCoverage: true },
): FakeExl3Venv {
  const venvRoot = path.join(root, 'venv');
  const scriptsDirectory = path.join(venvRoot, 'Scripts');
  const packageDirectory = path.join(venvRoot, 'Lib', 'site-packages', 'exllamav3');
  const generatorDirectory = path.join(packageDirectory, 'generator');
  const loaderDirectory = path.join(packageDirectory, 'loader');
  const modelDirectory = path.join(packageDirectory, 'model');
  fs.mkdirSync(scriptsDirectory, { recursive: true });
  fs.mkdirSync(generatorDirectory, { recursive: true });
  fs.mkdirSync(loaderDirectory, { recursive: true });
  fs.mkdirSync(modelDirectory, { recursive: true });
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
  const frozenTensorsPath = path.join(loaderDirectory, 'frozen_tensors.py');
  if (freezeSupport.frozenTensorSource) {
    fs.writeFileSync(frozenTensorsPath, FROZEN_TENSORS_SOURCE, 'utf8');
  } else {
    fs.rmSync(frozenTensorsPath, { force: true });
  }
  const modelSourcePath = path.join(modelDirectory, 'model.py');
  const modelSource = freezeSupport.modelFreeze
    ? FREEZE_MODEL_SOURCE + (freezeSupport.freezeCoverage ? FREEZE_COVERAGE_SOURCE : '')
    : UNPATCHED_MODEL_SOURCE;
  fs.writeFileSync(modelSourcePath, modelSource, 'utf8');
  return { pythonPath, jobSourcePath, frozenTensorsPath, modelSourcePath };
}

/** Reproduces a unified package source whose canonical directory differs from stale site-packages. */
export function writeFakeUnifiedExl3Venv(root: string): FakeUnifiedExl3Venv {
  const stale = writeFakeExl3Venv(root, false, {
    frozenTensorSource: false,
    modelFreeze: false,
    freezeCoverage: false,
  });
  const editableRoot = path.join(root, 'unified-exllamav3');
  const editablePackageDirectory = path.join(editableRoot, 'exllamav3');
  const generatorDirectory = path.join(editablePackageDirectory, 'generator');
  const loaderDirectory = path.join(editablePackageDirectory, 'loader');
  const modelDirectory = path.join(editablePackageDirectory, 'model');
  fs.mkdirSync(generatorDirectory, { recursive: true });
  fs.mkdirSync(loaderDirectory, { recursive: true });
  fs.mkdirSync(modelDirectory, { recursive: true });
  fs.writeFileSync(path.join(generatorDirectory, 'job.py'), DEVICE_RESIDENT_JOB_SOURCE, 'utf8');
  fs.writeFileSync(path.join(loaderDirectory, 'frozen_tensors.py'), FROZEN_TENSORS_SOURCE, 'utf8');
  fs.writeFileSync(path.join(modelDirectory, 'model.py'), FREEZE_MODEL_SOURCE + FREEZE_COVERAGE_SOURCE, 'utf8');

  return { ...stale, editablePackageDirectory };
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
  options: { announceDrafting?: boolean; draftingStream?: 'stdout' | 'stderr'; draftingDelayMs?: number } = {},
): FakeTabbyFiles {
  const announceDrafting = options.announceDrafting ?? true;
  const draftingStream = options.draftingStream ?? 'stdout';
  const draftingDelayMs = options.draftingDelayMs ?? 0;
  const fakeVenv = writeFakeExl3Venv(root, true);
  const files: FakeTabbyFiles = {
    scriptPath: path.join(root, 'fake-tabby.cjs'),
    pythonPath: fakeVenv.pythonPath,
    argsPath: path.join(root, 'args.json'),
    environmentPath: path.join(root, 'environment.json'),
    loadRequestsPath: path.join(root, 'load-requests.txt'),
    startsPath: path.join(root, 'starts.txt'),
    capabilities: createFakeExl3Capabilities(fakeVenv.pythonPath),
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
  setTimeout(() => {
    process.${draftingStream}.write('INFO: Using main model MTP component for drafting\\n');
  }, ${draftingDelayMs});
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
