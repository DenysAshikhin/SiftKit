import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';

import { Exl3LoadRequestSchema } from '../../src/inference-presets/exl3-preset-adapter.js';
import {
  Exl3ModelCapabilities,
  type Exl3PackageInspection,
  type Exl3PackageLocator,
} from '../../src/inference-presets/exl3-model-capabilities.js';
import type { ManagedEngineHost } from '../../src/status-server/engine-process.js';
import { FakeTabbyLauncher, type FakeTabbyOptions } from './in-process-tabby.js';

class FixedExl3PackageLocator implements Exl3PackageLocator {
  constructor(private readonly packageDirectory: string) {}

  inspectPackage(_pythonPath: string): Exl3PackageInspection {
    return fs.existsSync(this.packageDirectory)
      ? { status: 'resolved', packageDirectory: this.packageDirectory }
      : { status: 'package-missing' };
  }
}

/** Resolves the venv's own site-packages exllamav3 without running the interpreter. */
export function createFakeExl3PackageLocator(
  pythonPath: string,
  packageDirectory = path.join(path.dirname(path.dirname(pythonPath)), 'Lib', 'site-packages', 'exllamav3'),
): Exl3PackageLocator {
  return new FixedExl3PackageLocator(packageDirectory);
}

export function createFakeExl3Capabilities(pythonPath: string, packageDirectory?: string): Exl3ModelCapabilities {
  return new Exl3ModelCapabilities(createFakeExl3PackageLocator(pythonPath, packageDirectory));
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

export interface FakeExl3Venv {
  pythonPath: string;
  jobSourcePath: string;
}

export interface FakeUnifiedExl3Venv extends FakeExl3Venv {
  editablePackageDirectory: string;
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
 * `<venv>\\Lib\\site-packages\\exllamav3\\generator\\job.py`. A `launchable` interpreter is a hard
 * link to the running Node binary, for process tests that really start it; in-process hosts only
 * need the file to exist. `deviceResidentPastIds` selects an exllamav3 with or without
 * turboderp-org/exllamav3@8e08af9.
 */
export function writeFakeExl3Venv(
  root: string,
  deviceResidentPastIds: boolean,
  interpreter: 'placeholder' | 'launchable' = 'placeholder',
): FakeExl3Venv {
  const venvRoot = path.join(root, 'venv');
  const scriptsDirectory = path.join(venvRoot, 'Scripts');
  const packageDirectory = path.join(venvRoot, 'Lib', 'site-packages', 'exllamav3');
  const generatorDirectory = path.join(packageDirectory, 'generator');
  fs.mkdirSync(scriptsDirectory, { recursive: true });
  fs.mkdirSync(generatorDirectory, { recursive: true });
  const pythonPath = path.join(scriptsDirectory, path.basename(process.execPath));
  if (interpreter === 'placeholder') {
    fs.writeFileSync(pythonPath, '', 'utf8');
  } else if (!fs.existsSync(pythonPath)) {
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

/** Reproduces a unified package source whose canonical directory differs from stale site-packages. */
export function writeFakeUnifiedExl3Venv(root: string): FakeUnifiedExl3Venv {
  const stale = writeFakeExl3Venv(root, false);
  const editableRoot = path.join(root, 'unified-exllamav3');
  const editablePackageDirectory = path.join(editableRoot, 'exllamav3');
  const generatorDirectory = path.join(editablePackageDirectory, 'generator');
  fs.mkdirSync(generatorDirectory, { recursive: true });
  fs.writeFileSync(path.join(generatorDirectory, 'job.py'), DEVICE_RESIDENT_JOB_SOURCE, 'utf8');

  return { ...stale, editablePackageDirectory };
}

export interface FakeEngineHost {
  launcher: FakeTabbyLauncher;
  host: ManagedEngineHost;
  pythonPath: string;
}

/**
 * A managed-engine host that never leaves the test process: the venv interpreter resolves an
 * exllamav3 carrying the 8e08af9 watermark, and every launch is an in-process fake TabbyAPI.
 */
export function writeFakeEngineHost(root: string, options: FakeTabbyOptions): FakeEngineHost {
  const { pythonPath } = writeFakeExl3Venv(root, true);
  const launcher = new FakeTabbyLauncher(options);
  return { launcher, host: { launcher, packageLocator: createFakeExl3PackageLocator(pythonPath) }, pythonPath };
}
