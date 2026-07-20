import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { Exl3EngineConfig, ModelRuntimePreset } from '../config/types.js';
import {
  Exl3PresetAdapter,
  type Exl3LaunchEnvironment,
} from '../inference-presets/exl3-preset-adapter.js';
import { ManagedInferenceRuntime } from './managed-inference-runtime.js';
import { terminateProcessTree } from './managed-llama.js';
import { getManagedTabbyLogRoot } from './paths.js';
import { TabbyModelClient } from './tabby-model-client.js';

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function getBaseUrl(preset: ModelRuntimePreset): string {
  return preset.BaseUrl ?? 'http://127.0.0.1:8098';
}

export class ManagedTabbyRuntime extends ManagedInferenceRuntime {
  private child: ChildProcess | null = null;
  private stopping = false;
  private startupError: Error | null = null;
  private readonly logPath: string;
  private currentPreset: ModelRuntimePreset | null = null;
  private processBaseUrl: string | null = null;
  private processManaged: boolean | null = null;
  private processSignature: string | null = null;
  private residentPresetId: string | null = null;
  private loadPromise: Promise<void> | null = null;
  private readonly adapter: Exl3PresetAdapter;

  constructor(
    private readonly engine: Exl3EngineConfig,
    private readonly client = new TabbyModelClient(engine.AdminApiKey),
  ) {
    super('exl3');
    this.adapter = new Exl3PresetAdapter(engine.ModelRoot);
    this.logPath = path.join(getManagedTabbyLogRoot(), 'latest-startup.log');
  }

  private async startProcess(
    preset: ModelRuntimePreset,
    launchEnvironment: Exl3LaunchEnvironment | null,
    processSignature: string | null,
  ): Promise<void> {
    if (this.getProcessState() === 'ready') return;
    this.transitionProcessTo('starting');
    if (!this.shouldManage(preset)) {
      await this.waitForProcess(preset, processSignature);
      return;
    }
    if (launchEnvironment === null) {
      throw new Error('Managed TabbyAPI requires a launch environment.');
    }
    if (!this.child || this.child.exitCode !== null) this.spawnProcess(launchEnvironment);
    try {
      await this.waitForProcess(preset, processSignature);
    } catch (error) {
      try {
        await this.stopProcess();
      } finally {
        this.transitionProcessTo('failed');
      }
      throw error;
    }
  }

  async ensurePresetReady(preset: ModelRuntimePreset): Promise<void> {
    if (preset.Backend !== 'exl3') {
      throw new Error(`Preset '${preset.id}' cannot be loaded by the EXL3 runtime.`);
    }
    const managed = this.shouldManage(preset);
    const launchEnvironment = managed ? this.adapter.buildLaunchEnvironment(preset) : null;
    const processSignature = launchEnvironment ? JSON.stringify(launchEnvironment) : null;
    if (
      this.getProcessState() === 'ready'
      && (
        this.processBaseUrl !== getBaseUrl(preset)
        || this.processManaged !== managed
        || this.processSignature !== processSignature
      )
    ) await this.stopProcess();
    this.currentPreset = preset;
    if (this.getProcessState() !== 'ready') {
      await this.startProcess(preset, launchEnvironment, processSignature);
    }
    if (this.residentPresetId === preset.id && this.getModelState() === 'ready') return;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.loadPreset(preset);
    try {
      await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
  }

  async unloadPreset(): Promise<void> {
    if (this.loadPromise) await this.loadPromise;
    if (this.getModelState() === 'unloaded') return;
    const preset = this.currentPreset;
    if (!preset) throw new Error('Cannot unload EXL3 without a validated current preset.');
    this.transitionModelTo('unloading');
    try {
      await this.client.unload(getBaseUrl(preset), preset.HealthcheckTimeoutMs);
      this.residentPresetId = null;
      this.transitionModelTo('unloaded');
    } catch (error) {
      this.transitionModelTo('failed');
      throw error;
    }
  }

  async stopProcess(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) {
      this.child = null;
      this.processBaseUrl = null;
      this.processManaged = null;
      this.processSignature = null;
      this.currentPreset = null;
      this.residentPresetId = null;
      this.transitionModelTo('unloaded');
      this.transitionProcessTo('stopped');
      return;
    }
    this.stopping = true;
    this.transitionProcessTo('stopping');
    if (child.pid) terminateProcessTree(child.pid);
    const deadline = Date.now() + this.engine.ShutdownTimeoutMs;
    while (child.exitCode === null && Date.now() < deadline) await delay(25);
    if (child.exitCode === null) {
      this.transitionProcessTo('failed');
      throw new Error('Timed out stopping TabbyAPI.');
    }
    this.child = null;
    this.processBaseUrl = null;
    this.processManaged = null;
    this.processSignature = null;
    this.currentPreset = null;
    this.residentPresetId = null;
    this.transitionModelTo('unloaded');
    this.transitionProcessTo('stopped');
  }

  stopForProcessExitSync(): void {
    const child = this.child;
    this.stopping = true;
    if (child?.pid && child.exitCode === null) terminateProcessTree(child.pid);
    this.child = null;
    this.processBaseUrl = null;
    this.processManaged = null;
    this.processSignature = null;
    this.currentPreset = null;
    this.residentPresetId = null;
    this.transitionModelTo('unloaded');
    this.transitionProcessTo('stopped');
  }

  private spawnProcess(launchEnvironment: Exl3LaunchEnvironment): void {
    this.stopping = false;
    this.startupError = null;
    fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
    fs.writeFileSync(this.logPath, '', 'utf8');
    const configPath = path.resolve(this.engine.WorkingDirectory, this.engine.ConfigPath);
    const child = spawn(this.engine.PythonPath, [this.engine.Entrypoint, '--config', configPath], {
      cwd: this.engine.WorkingDirectory,
      env: { ...process.env, ...launchEnvironment },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout?.on('data', (chunk) => this.appendLog('stdout', chunk));
    child.stderr?.on('data', (chunk) => this.appendLog('stderr', chunk));
    child.once('error', (error) => {
      this.startupError = error;
      this.transitionProcessTo('failed');
    });
    child.once('exit', (code, signal) => {
      if (this.stopping) return;
      this.startupError = new Error(`TabbyAPI exited unexpectedly (code=${String(code)}, signal=${String(signal)}).`);
      this.processBaseUrl = null;
      this.processManaged = null;
      this.processSignature = null;
      this.transitionModelTo('unloaded');
      this.transitionProcessTo('failed');
    });
  }

  private async waitForProcess(preset: ModelRuntimePreset, processSignature: string | null): Promise<void> {
    const deadline = Date.now() + preset.StartupTimeoutMs;
    const baseUrl = getBaseUrl(preset);
    const expectedModel = this.shouldManage(preset)
      ? this.adapter.buildLoadRequest(preset).model_name
      : null;
    while (Date.now() < deadline) {
      if (this.startupError) throw this.startupError;
      const processReady = await this.client.isProcessReady(baseUrl, preset.HealthcheckTimeoutMs);
      if (processReady) {
        const modelReady = expectedModel === null
          || (await this.client.listModels(baseUrl, preset.HealthcheckTimeoutMs)).includes(expectedModel);
        if (modelReady) {
          this.processBaseUrl = baseUrl;
          this.processManaged = this.shouldManage(preset);
          this.processSignature = processSignature;
          this.transitionProcessTo('ready');
          return;
        }
      }
      await delay(preset.HealthcheckIntervalMs);
    }
    this.transitionProcessTo('failed');
    throw new Error('Timed out waiting for the TabbyAPI process.');
  }

  private async loadPreset(preset: ModelRuntimePreset): Promise<void> {
    this.transitionModelTo('loading');
    try {
      const request = this.adapter.buildLoadRequest(preset);
      if (this.shouldManage(preset)) {
        const models = await this.client.listModels(getBaseUrl(preset), preset.HealthcheckTimeoutMs);
        if (!models.includes(request.model_name)) {
          throw new Error(`TabbyAPI started without requested model '${request.model_name}' resident.`);
        }
      } else {
        await this.client.load(getBaseUrl(preset), request, preset.StartupTimeoutMs);
      }
      this.residentPresetId = preset.id;
      this.transitionModelTo('ready');
    } catch (error) {
      this.transitionModelTo('failed');
      throw error;
    }
  }

  private shouldManage(preset: ModelRuntimePreset): boolean {
    return this.engine.Managed && !preset.ExternalServerEnabled;
  }

  private appendLog(stream: 'stdout' | 'stderr', chunk: string | Buffer): void {
    fs.appendFileSync(this.logPath, `[${stream}] ${String(chunk)}`, 'utf8');
  }
}
