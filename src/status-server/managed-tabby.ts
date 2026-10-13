import { existsSync } from 'node:fs';

import type { Exl3EngineConfig, ModelRuntimePreset } from '../config/types.ts';
import { toError } from '../lib/errors.ts';
import {
  Exl3PresetAdapter,
  type Exl3LaunchEnvironment,
} from '../inference-presets/exl3-preset-adapter.ts';
import { Exl3ModelCapabilities } from '../inference-presets/exl3-model-capabilities.ts';
import { ManagedInferenceRuntime } from './managed-inference-runtime.ts';
import type { InferenceRunFlushQueue } from './inference-run-flush-queue.ts';
import type { EngineProcess, ManagedEngineHost } from './engine-process.ts';
import { serverLogger } from './server-logger.ts';
import { TabbyModelClient } from './tabby-model-client.ts';
import { TabbyRunRecorder } from './tabby-run-recorder.ts';

const STARTUP_LOG_POLL_INTERVAL_MS = 25;
const MIB = 1_048_576;
/** Allowance for other GPU clients drifting while an engine ran; a resident model is far larger. */
const VRAM_RELEASE_TOLERANCE_BYTES = 1_024 * MIB;
const VRAM_RELEASE_POLL_MS = 250;
/** How long an exit waits for engine stderr to end, so the traceback's last line is read. */
const EXIT_STDERR_DRAIN_MS = 1_000;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function getBaseUrl(preset: ModelRuntimePreset): string {
  return new URL(preset.BaseUrl ?? 'http://127.0.0.1:8098').origin;
}

export class ManagedTabbyRuntime extends ManagedInferenceRuntime {
  private child: EngineProcess | null = null;
  private stopping = false;
  private startupError: Error | null = null;
  private recorder: TabbyRunRecorder | null = null;
  private currentPreset: ModelRuntimePreset | null = null;
  private processBaseUrl: string | null = null;
  private processManaged: boolean | null = null;
  private processSignature: string | null = null;
  private residentResidencyKey: string | null = null;
  private loadPromise: Promise<void> | null = null;
  private vramBaselineUsedBytes: number | null = null;
  private readonly adapter: Exl3PresetAdapter;
  private readonly capabilities: Exl3ModelCapabilities;

  private readonly engine: Exl3EngineConfig;
  private readonly flushQueue: InferenceRunFlushQueue;
  private readonly host: ManagedEngineHost;
  private readonly client: TabbyModelClient;

  constructor(
    engine: Exl3EngineConfig,
    flushQueue: InferenceRunFlushQueue,
    host: ManagedEngineHost,
    client = new TabbyModelClient(engine.AdminApiKey),
  ) {
    super('exl3');
    this.client = client;
    this.engine = engine;
    this.flushQueue = flushQueue;
    this.host = host;
    this.adapter = new Exl3PresetAdapter(engine.ModelRoot);
    this.capabilities = new Exl3ModelCapabilities(host.packageLocator);
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
    try {
      if (!this.child || this.child.exitCode !== null) {
        this.vramBaselineUsedBytes = (await this.host.gpuMemory.read())?.usedBytes ?? null;
        this.spawnProcess(launchEnvironment);
      }
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
    if (!managed && preset.SpeculativeEnabled) {
      throw new Error(
        `Preset '${preset.id}' requires speculative drafting, but TabbyAPI's /v1/model/load cannot enable MTP drafting `
        + 'on a server SiftKit did not launch. Use a managed launch or disable SpeculativeEnabled.',
      );
    }
    if (!managed && preset.DiskCacheDir !== null) {
      throw new Error(
        `Preset '${preset.id}' sets DiskCacheDir, but the disk cache is a launch setting that only a SiftKit-managed `
        + 'TabbyAPI can apply. Use a managed launch or clear DiskCacheDir.',
      );
    }
    const launchEnvironment = managed ? this.adapter.buildLaunchEnvironment(preset) : null;
    const processSignature = launchEnvironment
      ? JSON.stringify(this.getEngineIdentity(launchEnvironment))
      : null;
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
    if (this.residentResidencyKey === this.getPresetResidencyKey(preset) && this.getModelState() === 'ready') return;
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
    if (this.shouldManage(preset)) {
      await this.stopProcess();
      return;
    }
    this.transitionModelTo('unloading');
    try {
      await this.client.unload(getBaseUrl(preset), preset.HealthcheckTimeoutMs);
      this.residentResidencyKey = null;
      this.transitionModelTo('unloaded');
    } catch (error) {
      this.transitionModelTo('failed');
      throw error;
    }
  }

  async stopProcess(): Promise<void> {
    const child = this.child;
    if (child && child.exitCode === null) {
      this.stopping = true;
      this.transitionProcessTo('stopping');
      await this.flushDiskCache();
    }
    // One budget covers both the exit and the VRAM release; it starts once the flush is done.
    const deadline = Date.now() + this.engine.ShutdownTimeoutMs;
    if (child && child.exitCode === null) {
      this.host.launcher.terminate(child);
      while (child.exitCode === null && Date.now() < deadline) await delay(25);
      if (child.exitCode === null) {
        this.transitionProcessTo('failed');
        throw new Error('Timed out stopping TabbyAPI.');
      }
    }
    this.child = null;
    this.recorder = null;
    this.processBaseUrl = null;
    this.processManaged = null;
    this.processSignature = null;
    this.currentPreset = null;
    this.residentResidencyKey = null;
    this.transitionModelTo('unloaded');
    await this.waitForVramRelease(deadline);
    this.transitionProcessTo('stopped');
  }

  /** Drains a disk-cache preset's pending writes through Tabby's unload (generator.close); a failure never blocks the stop. */
  private async flushDiskCache(): Promise<void> {
    const preset = this.currentPreset;
    const baseUrl = this.processBaseUrl;
    if (preset === null || preset.DiskCacheDir === null || baseUrl === null || this.getModelState() !== 'ready') return;
    try {
      await this.client.unload(baseUrl, this.engine.ShutdownTimeoutMs);
    } catch (error) {
      serverLogger.warning({ scope: 'exl3', id: preset.id, event: 'disk_cache_flush_failed', fields: '',
        alert: toError(error).message });
    }
  }

  /**
   * Resolves once GPU use is back to its pre-launch level; Windows frees an exited engine's VRAM with a lag.
   * No baseline means the GPU was unmeasurable at launch (the probe's documented "skip"); losing it later is an error.
   */
  private async waitForVramRelease(deadline: number): Promise<void> {
    const baseline = this.vramBaselineUsedBytes;
    if (baseline === null) return;
    for (;;) {
      const memory = await this.host.gpuMemory.read();
      if (memory === null) {
        this.transitionProcessTo('failed');
        throw new Error(`GPU memory could not be read after stopping TabbyAPI (${Math.round(baseline / MIB)} MiB before launch).`);
      }
      if (memory.usedBytes <= baseline + VRAM_RELEASE_TOLERANCE_BYTES) {
        this.vramBaselineUsedBytes = null;
        return;
      }
      if (Date.now() >= deadline) {
        this.transitionProcessTo('failed');
        throw new Error(`TabbyAPI stopped, but GPU memory was not released within ${this.engine.ShutdownTimeoutMs} ms `
          + `(${Math.round(memory.usedBytes / MIB)} MiB used; ${Math.round(baseline / MIB)} MiB before launch).`);
      }
      await delay(VRAM_RELEASE_POLL_MS);
    }
  }

  stopForProcessExitSync(): void {
    const child = this.child;
    this.stopping = true;
    if (child && child.exitCode === null) this.host.launcher.terminate(child);
    this.child = null;
    this.recorder = null;
    this.processBaseUrl = null;
    this.processManaged = null;
    this.processSignature = null;
    this.currentPreset = null;
    this.residentResidencyKey = null;
    this.transitionModelTo('unloaded');
    this.transitionProcessTo('stopped');
  }

  private spawnProcess(launchEnvironment: Exl3LaunchEnvironment): void {
    if (!existsSync(this.engine.PythonPath)) {
      throw new Error(`Configured EXL3 Python interpreter does not exist: ${this.engine.PythonPath}`);
    }
    const compatibility = this.capabilities.inspectDeviceResidentPastIds(this.engine.PythonPath);
    if (compatibility === 'interpreter-unavailable') {
      throw new Error(`Configured EXL3 Python interpreter cannot run the package probe: ${this.engine.PythonPath}`);
    }
    if (compatibility === 'package-missing') {
      throw new Error(`Configured EXL3 Python interpreter has no importable exllamav3 package: ${this.engine.PythonPath}`);
    }
    if (compatibility === 'incompatible') {
      throw new Error(
        `${this.engine.PythonPath} has no exllamav3 with turboderp-org/exllamav3@8e08af9 `
        + '(no pinned_ids_valid watermark in generator/job.py). SiftKit no longer ships OMP_NUM_THREADS=1, '
        + 'KMP_BLOCKTIME=1 or penalty_range, so this build would burn ~11.5 CPU cores per decode step with an '
        + 'unbounded penalty window. Install exllamav3 at or after 8e08af9 — see '
        + 'docs/exl3-penalty-range-upstream-fix-2026-07-30.md §5.1.',
      );
    }
    this.stopping = false;
    this.startupError = null;
    const recorder = new TabbyRunRecorder({
      backend: 'exl3',
      purpose: 'startup',
      entrypointPath: this.engine.Entrypoint,
      baseUrl: null,
      flushQueue: this.flushQueue,
    });
    recorder.enableFlushQueue();
    this.recorder = recorder;
    const launch = this.getEngineIdentity(launchEnvironment);
    const child = this.host.launcher.launch({
      command: launch.pythonPath,
      args: [launch.entrypoint],
      workingDirectory: launch.workingDirectory,
      environment: { ...process.env, ...launch.environment },
    });
    this.child = child;
    recorder.attachEngineStdout(child.stdout);
    recorder.attachEngineStderr(child.stderr);
    child.once('error', (error) => {
      this.startupError = error;
      recorder.finalize({ status: 'failed', errorMessage: error.message });
      this.transitionProcessTo('failed');
    });
    child.once('exit', (code, signal) => {
      void this.settleExit(child, recorder, this.stopping, code, signal);
    });
  }

  /** Records an engine exit; 'exit' can precede the last stderr chunk, so the traceback is read once stderr ends. */
  private async settleExit(child: EngineProcess, recorder: TabbyRunRecorder, stopping: boolean,
    code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    await recorder.waitForEngineStderrEnd(EXIT_STDERR_DRAIN_MS);
    const exitStatus = `TabbyAPI exited unexpectedly (code=${String(code)}, signal=${String(signal)})`;
    const engineError = recorder.lastEngineError();
    const exitMessage = engineError === null ? `${exitStatus}.` : `${exitStatus}: ${engineError}`;
    recorder.finalize({
      status: stopping ? 'stopped' : 'failed',
      exitCode: Number.isFinite(code) ? Number(code) : null,
      errorMessage: stopping ? null : exitMessage,
    });
    if (stopping || this.child !== child) return;
    this.startupError = new Error(exitMessage);
    this.processBaseUrl = null;
    this.processManaged = null;
    this.processSignature = null;
    this.transitionModelTo('unloaded');
    this.transitionProcessTo('failed');
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
          || (await this.client.getResidentModel(baseUrl, preset.HealthcheckTimeoutMs))?.id === expectedModel;
        if (modelReady) {
          this.processBaseUrl = baseUrl;
          this.processManaged = this.shouldManage(preset);
          this.processSignature = processSignature;
          this.recorder?.finish({ status: 'ready', baseUrl });
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
        await this.client.verifyResident(getBaseUrl(preset), request, preset.HealthcheckTimeoutMs);
        if (preset.SpeculativeEnabled) await this.assertDraftingActive(preset);
      } else {
        await this.client.load(getBaseUrl(preset), request, preset.StartupTimeoutMs);
      }
      this.residentResidencyKey = this.getPresetResidencyKey(preset);
      this.transitionModelTo('ready');
    } catch (error) {
      this.transitionModelTo('failed');
      throw error;
    }
  }

  /**
   * TabbyAPI's /v1/model card reports `draft: null` even while MTP drafting is active, so the
   * startup log line from the exllamav3 backend is the only signal that drafting engaged. It can
   * land on either stream: TabbyAPI logs through loguru, which writes to stderr by default.
   */
  private async assertDraftingActive(preset: ModelRuntimePreset): Promise<void> {
    const deadline = Date.now() + preset.HealthcheckTimeoutMs;
    while (Date.now() <= deadline) {
      if (this.recorder?.hasMtpDraftingMarker()) {
        return;
      }
      await delay(Math.min(STARTUP_LOG_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
    }
    throw new Error(
      `Preset '${preset.id}' requires MTP drafting, but the TabbyAPI startup log never reported the MTP draft `
      + 'component loading. Decode speed would be silently halved.',
    );
  }

  private shouldManage(preset: ModelRuntimePreset): boolean {
    return this.engine.Managed && !preset.ExternalServerEnabled;
  }

  // Use the same effective launch environment for identity and process creation.
  private getEngineIdentity(launchEnvironment: Exl3LaunchEnvironment) {
    return {
      pythonPath: this.engine.PythonPath,
      entrypoint: this.engine.Entrypoint,
      workingDirectory: this.engine.WorkingDirectory,
      environment: Object.fromEntries(
        Object.entries({ ...this.engine.Environment, ...launchEnvironment })
          .sort(([left], [right]) => left.localeCompare(right)),
      ),
    };
  }

  // External servers retain load identity and admission capacity without managed launch fields.
  getPresetResidencyKey(preset: ModelRuntimePreset): string {
    const managed = this.shouldManage(preset);
    return JSON.stringify({
      backend: preset.Backend,
      baseUrl: getBaseUrl(preset),
      managed,
      model: preset.Model,
      load: this.adapter.buildLoadRequest(preset),
      launch: managed ? this.getEngineIdentity(this.adapter.buildLaunchEnvironment(preset)) : null,
      parallelSlots: preset.ParallelSlots,
    });
  }
}
