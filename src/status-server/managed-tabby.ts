import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { Exl3Profile } from '../config/types.js';
import { LlamaCppClient } from '../llm-protocol/llama-cpp-client.js';
import { ManagedInferenceRuntime } from './managed-inference-runtime.js';
import { terminateProcessTree } from './managed-llama.js';
import { getManagedTabbyLogRoot } from './paths.js';

const tabbyCapabilities = {
  chatTemplateKwargs: true,
  reasoningContent: true,
  toolCalling: true,
  jsonSchema: true,
  speculativeMode: 'mtp',
  reusablePrefixCache: 'unknown',
} as const;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class ManagedTabbyRuntime extends ManagedInferenceRuntime {
  private child: ChildProcess | null = null;
  private readonly client = new LlamaCppClient();
  private stopping = false;
  private startupError: Error | null = null;
  private readonly logPath: string;

  constructor(private readonly profile: Exl3Profile) {
    super('exl3', profile.BaseUrl, profile.ModelId, tabbyCapabilities);
    this.logPath = path.join(getManagedTabbyLogRoot(), 'latest-startup.log');
  }

  async start(): Promise<void> {
    if (!this.profile.Managed) {
      this.transitionTo('starting');
      await this.waitUntilReady();
      return;
    }
    if (this.child && this.child.exitCode === null) {
      await this.waitUntilReady();
      return;
    }

    this.transitionTo('starting');
    this.stopping = false;
    this.startupError = null;
    fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
    fs.writeFileSync(this.logPath, '', 'utf8');
    const child = spawn(this.profile.PythonPath, [this.profile.Entrypoint], {
      cwd: this.profile.WorkingDirectory,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout?.on('data', (chunk) => this.appendLog('stdout', chunk));
    child.stderr?.on('data', (chunk) => this.appendLog('stderr', chunk));
    child.once('error', (error) => {
      this.startupError = error;
      this.transitionTo('failed');
    });
    child.once('exit', (code, signal) => {
      if (this.stopping) {
        return;
      }
      this.startupError = new Error(`TabbyAPI exited unexpectedly (code=${String(code)}, signal=${String(signal)}).`);
      this.transitionTo('failed');
    });
    await this.waitUntilReady();
  }

  async waitUntilReady(): Promise<void> {
    const deadline = Date.now() + this.profile.StartupTimeoutMs;
    while (Date.now() < deadline) {
      if (this.startupError) {
        throw this.startupError;
      }
      try {
        const response = await this.client.probeModelsAtBaseUrl(
          this.profile.BaseUrl,
          this.profile.HealthcheckTimeoutMs,
        );
        if (response.statusCode < 400 && response.models.includes(this.profile.ModelId)) {
          this.transitionTo('ready');
          return;
        }
      } catch {
        // Cold model loading can reject connections until the API is ready.
      }
      await delay(this.profile.HealthcheckIntervalMs);
    }
    this.transitionTo('failed');
    throw new Error(`Timed out waiting for TabbyAPI model '${this.profile.ModelId}'.`);
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) {
      this.child = null;
      this.transitionTo('stopped');
      return;
    }
    this.stopping = true;
    this.transitionTo('stopping');
    if (child.pid) {
      terminateProcessTree(child.pid);
    }
    const deadline = Date.now() + this.profile.ShutdownTimeoutMs;
    while (child.exitCode === null && Date.now() < deadline) {
      await delay(25);
    }
    if (child.exitCode === null) {
      this.transitionTo('failed');
      throw new Error('Timed out stopping TabbyAPI.');
    }
    this.child = null;
    this.transitionTo('stopped');
  }

  private appendLog(stream: 'stdout' | 'stderr', chunk: string | Buffer): void {
    fs.appendFileSync(this.logPath, `[${stream}] ${String(chunk)}`, 'utf8');
  }
}
