import {
  applyModelOverrideToConfig,
  getActiveModelPreset,
  getConfigPath,
  getConfiguredReasoning,
  type SiftConfig,
} from '../config/index.js';
import type {
  PresetListItem,
  PresetListResult,
  PresetRunRequest,
  PresetRunResult,
} from '../command-output/types.js';
import {
  normalizeOperationModeAllowedTools,
  resolvePresetAllowedTools,
  type PresetToolName,
  type PresetKind,
  type SiftPreset,
} from '../presets.js';
import { PresetCatalog } from '../preset-catalog.js';
import type { RepoSearchExecutionResult } from '../repo-search/types.js';
import type { RepoSearchProgressEvent } from './dashboard-runs.js';
import type { ChatSession } from '../state/chat-sessions.js';
import type { SummaryPolicyProfile } from '../summary/types.js';
import {
  SUMMARY_PLANNER_TOOL_NAMES,
  type SummaryPlannerToolName as PlannerToolName,
} from '../planner-protocol/summary-tools.js';
import type { SummaryProgressEvent } from '../summary/progress-reporter.js';
import type { ProgressWriter } from '../lib/progress-writer.js';
import {
  buildChatSystemContent,
  buildPlanMarkdownFromRepoSearch,
  buildPlanRequestPrompt,
  buildRepoSearchMarkdown,
} from './chat.js';
import { readConfig } from './config-store.js';
import type { StatusEngineService } from './engine-service.js';
import { normalizeRepoSearchResult } from './repo-search-scorecard-types.js';

type PresetRunOptions = {
  statusBackendUrl: string;
  summaryProgressWriter?: ProgressWriter<SummaryProgressEvent>;
  repoSearchProgressWriter?: ProgressWriter<RepoSearchProgressEvent>;
  abortSignal?: AbortSignal;
};

type ServerPresetConfig = SiftConfig;

const SUMMARY_PLANNER_TOOL_NAME_SET: ReadonlySet<string> = new Set(SUMMARY_PLANNER_TOOL_NAMES);

function isSummaryPlannerTool(toolName: PresetToolName): toolName is PlannerToolName {
  return SUMMARY_PLANNER_TOOL_NAME_SET.has(toolName);
}

function readPresetConfig(): ServerPresetConfig {
  return readConfig(getConfigPath());
}

function getCliPresets(): SiftPreset[] {
  const config = readPresetConfig();
  return PresetCatalog.fromPresets(config.Presets).forSurface('cli');
}

function getPresetById(presetId: string): SiftPreset {
  const preset = PresetCatalog.fromPresets(readPresetConfig().Presets).requireById(presetId);
  if (!preset.surfaces.includes('cli')) {
    throw new Error(`Preset '${presetId}' was not found.`);
  }
  return preset;
}

function normalizePresetPolicyProfile(value: string | null | undefined): SummaryPolicyProfile {
  return (
    value === 'general'
    || value === 'pass-fail'
    || value === 'unique-errors'
    || value === 'buried-critical'
    || value === 'json-extraction'
    || value === 'diff-summary'
    || value === 'risky-operation'
  ) ? value : 'general';
}

function getPresetPrompt(request: PresetRunRequest): string {
  return String(request.prompt || request.question || '').trim();
}

function getRepoRoot(request: PresetRunRequest): string {
  return String(request.repoRoot || process.cwd()).trim() || process.cwd();
}

/** Which runner branch a preset kind dispatches to; `plan` and `repo-search` share the repo-search runner. */
export function selectPresetRunKind(presetKind: PresetKind): 'summary' | 'chat' | 'repo-search' {
  if (presetKind === 'summary') {
    return 'summary';
  }
  if (presetKind === 'chat') {
    return 'chat';
  }
  return 'repo-search';
}

function getFinalOutput(result: RepoSearchExecutionResult): string {
  const repoSearchResult = normalizeRepoSearchResult(result);
  const finalOutput = repoSearchResult.scorecard.tasks
    .map((task) => task.finalOutput.trim())
    .find((value) => value.length > 0);
  return finalOutput || '';
}

export class StatusPresetRunner {
  constructor(private readonly engineService: StatusEngineService) {}

  listPresets(): PresetListResult {
    const presets = getCliPresets();
    const items: PresetListItem[] = presets.map((preset) => ({
      id: preset.id,
      presetKind: preset.presetKind,
      operationMode: preset.operationMode,
      deletable: preset.deletable,
      label: preset.label,
    }));
    return { presets: items };
  }

  async run(request: PresetRunRequest, options: PresetRunOptions): Promise<PresetRunResult> {
    const config = readPresetConfig();
    const preset = getPresetById(request.presetId);
    const effectiveAllowedTools = resolvePresetAllowedTools(
      preset,
      normalizeOperationModeAllowedTools(config.OperationModeAllowedTools),
    );

    const runKind = selectPresetRunKind(preset.presetKind);
    if (runKind === 'summary') {
      return this.runSummaryPreset(request, config, preset, effectiveAllowedTools, options);
    }
    if (runKind === 'chat') {
      return this.runChatPreset(request, config, preset, options);
    }
    return this.runRepoSearchPreset(request, config, preset, effectiveAllowedTools, options);
  }

  private async runSummaryPreset(
    request: PresetRunRequest,
    config: ServerPresetConfig,
    preset: SiftPreset,
    effectiveAllowedTools: PresetToolName[],
    options: PresetRunOptions,
  ): Promise<PresetRunResult> {
    const question = String(request.question || request.prompt || '').trim();
    if (!question) {
      throw new Error('A question is required.');
    }
    const inputText = typeof request.inputText === 'string' ? request.inputText : '';
    if (!inputText.trim()) {
      throw new Error('stdin, --text or --file required');
    }
    const result = await this.engineService.summarize({
      repoRoot: getRepoRoot(request),
      presetId: preset.id,
      question,
      inputText,
      images: [],
      format: request.format === 'json' ? 'json' : 'text',
      policyProfile: normalizePresetPolicyProfile(request.profile),
      provider: request.provider,
      model: request.model,
      allowedPlannerTools: effectiveAllowedTools.filter(isSummaryPlannerTool),
      sourceKind: request.sourceKind === 'command-output' ? 'command-output' : 'standalone',
      commandExitCode: Number.isFinite(Number(request.commandExitCode)) ? Number(request.commandExitCode) : undefined,
      statusBackendUrl: options.statusBackendUrl,
      config,
      progressWriter: options.summaryProgressWriter,
      abortSignal: options.abortSignal,
    });
    return { outputText: result.Summary };
  }

  private async runChatPreset(
    request: PresetRunRequest,
    config: ServerPresetConfig,
    preset: SiftPreset,
    options: PresetRunOptions,
  ): Promise<PresetRunResult> {
    const prompt = getPresetPrompt(request);
    if (!prompt) {
      throw new Error('A prompt is required.');
    }
    const now = new Date().toISOString();
    // Snapshot after the --model overlay so the session records the model it ran with.
    const effectiveConfig = applyModelOverrideToConfig(config, request.model);
    const activeModelPreset = getActiveModelPreset(effectiveConfig);
    const thinkingEnabled = getConfiguredReasoning(effectiveConfig) !== 'off';
    const session: ChatSession = {
      id: 'cli-ephemeral',
      title: preset.label,
      modelPresetId: activeModelPreset.id,
      modelPreset: activeModelPreset,
      thinkingEnabled,
      presetId: preset.id,
      mode: 'chat',
      planRepoRoot: getRepoRoot(request),
      createdAtUtc: now,
      updatedAtUtc: now,
      messages: [],
    };
    const result = await this.engineService.executeRepoSearch({
      presetId: preset.id,
      taskKind: 'chat',
      prompt,
      repoRoot: getRepoRoot(request),
      config: effectiveConfig,
      statusBackendUrl: options.statusBackendUrl,
      systemPrompt: buildChatSystemContent(effectiveConfig, session),
      history: [],
      thinkingEnabled,
      allowedTools: [],
      progressWriter: options.repoSearchProgressWriter,
      abortSignal: options.abortSignal,
    });
    return { outputText: getFinalOutput(result) };
  }

  private async runRepoSearchPreset(
    request: PresetRunRequest,
    config: ServerPresetConfig,
    preset: SiftPreset,
    effectiveAllowedTools: PresetToolName[],
    options: PresetRunOptions,
  ): Promise<PresetRunResult> {
    const prompt = getPresetPrompt(request);
    if (!prompt) {
      throw new Error('A prompt is required.');
    }
    const repoRoot = getRepoRoot(request);
    const result = await this.engineService.executeRepoSearch({
      presetId: preset.id,
      taskKind: preset.presetKind === 'plan' ? 'plan' : 'repo-search',
      prompt: preset.presetKind === 'plan' ? buildPlanRequestPrompt(prompt) : prompt,
      repoRoot,
      config,
      model: request.model,
      statusBackendUrl: options.statusBackendUrl,
      maxTurns: Number.isFinite(Number(request.maxTurns)) && Number(request.maxTurns) > 0
        ? Number(request.maxTurns)
        : preset.maxTurns ?? undefined,
      logFile: request.logFile,
      allowedTools: effectiveAllowedTools,
      progressWriter: options.repoSearchProgressWriter,
      abortSignal: options.abortSignal,
    });
    const outputText = preset.presetKind === 'plan'
      ? buildPlanMarkdownFromRepoSearch(prompt, repoRoot, result)
      : buildRepoSearchMarkdown(prompt, repoRoot, result);
    return { outputText };
  }
}
