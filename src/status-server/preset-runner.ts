import {
  getActiveModelPreset,
  getConfigPath,
  getConfiguredLlamaNumCtx,
  type SiftConfig,
} from '../config/index.js';
import type {
  PresetListItem,
  PresetListResult,
  PresetRunRequest,
  PresetRunResult,
} from '../command-output/types.js';
import {
  findPresetById,
  getPresetsForSurface,
  normalizeOperationModeAllowedTools,
  normalizePresets,
  resolvePresetAllowedTools,
  type PresetToolName,
  type PresetKind,
  type SiftPreset,
} from '../presets.js';
import type { RepoSearchExecutionResult } from '../repo-search/types.js';
import type { RepoSearchProgressEvent } from './dashboard-runs.js';
import type { ChatSession } from '../state/chat-sessions.js';
import type { PlannerToolName, SummaryPolicyProfile } from '../summary/types.js';
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
  onRepoSearchProgress?: (event: RepoSearchProgressEvent) => void;
  abortSignal?: AbortSignal;
};

type ServerPresetConfig = SiftConfig;

const SUMMARY_PLANNER_TOOL_NAMES: ReadonlySet<string> = new Set(['find_text', 'read_lines', 'json_filter', 'json_get']);

function isSummaryPlannerTool(toolName: PresetToolName): toolName is PlannerToolName {
  return SUMMARY_PLANNER_TOOL_NAMES.has(toolName);
}

function readPresetConfig(): ServerPresetConfig {
  return readConfig(getConfigPath());
}

function getCliPresets(): SiftPreset[] {
  const config = readPresetConfig();
  return getPresetsForSurface(normalizePresets(config.Presets), 'cli');
}

function getPromptPrefix(config: SiftConfig, preset: SiftPreset): string {
  return preset.promptPrefix.trim() || String(config.PromptPrefix || '').trim();
}

function getPresetById(presetId: string): SiftPreset {
  const preset = findPresetById(getCliPresets(), presetId);
  if (!preset) {
    throw new Error(`Unknown CLI preset: ${presetId}`);
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

function resolveEffectiveAgentsMd(config: Pick<SiftConfig, 'IncludeAgentsMd'>, preset: Pick<SiftPreset, 'includeAgentsMd'>): boolean {
  return config.IncludeAgentsMd !== false && preset.includeAgentsMd !== false;
}

function resolveEffectiveRepoFileListing(config: Pick<SiftConfig, 'IncludeRepoFileListing'>, preset: Pick<SiftPreset, 'includeRepoFileListing'>): boolean {
  return config.IncludeRepoFileListing !== false && preset.includeRepoFileListing !== false;
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
      question,
      inputText,
      format: request.format === 'json' ? 'json' : 'text',
      policyProfile: normalizePresetPolicyProfile(request.profile),
      backend: request.backend,
      model: request.model,
      promptPrefix: getPromptPrefix(config, preset),
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
    const activeModelPreset = getActiveModelPreset(config);
    const session: ChatSession = {
      id: 'cli-ephemeral',
      title: preset.label,
      modelPresetId: activeModelPreset.id,
      model: request.model,
      contextWindowTokens: getConfiguredLlamaNumCtx(config),
      thinkingEnabled: true,
      presetId: preset.id,
      mode: 'chat',
      planRepoRoot: getRepoRoot(request),
      condensedSummary: '',
      createdAtUtc: now,
      updatedAtUtc: now,
      messages: [],
    };
    const result = await this.engineService.executeRepoSearch({
      taskKind: 'chat',
      prompt,
      repoRoot: getRepoRoot(request),
      config,
      model: request.model,
      statusBackendUrl: options.statusBackendUrl,
      systemPrompt: buildChatSystemContent(config, session, {
        promptPrefix: preset.promptPrefix.trim() || undefined,
      }),
      history: [],
      thinkingEnabled: true,
      allowedTools: [],
      onProgress: options.onRepoSearchProgress,
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
      taskKind: preset.presetKind === 'plan' ? 'plan' : 'repo-search',
      prompt: preset.presetKind === 'plan' ? buildPlanRequestPrompt(prompt) : prompt,
      promptPrefix: preset.presetKind === 'repo-search' ? preset.promptPrefix : '',
      repoRoot,
      config,
      model: request.model,
      statusBackendUrl: options.statusBackendUrl,
      maxTurns: Number.isFinite(Number(request.maxTurns)) && Number(request.maxTurns) > 0
        ? Number(request.maxTurns)
        : preset.maxTurns ?? undefined,
      logFile: request.logFile,
      allowedTools: effectiveAllowedTools,
      includeAgentsMd: resolveEffectiveAgentsMd(config, preset),
      includeRepoFileListing: resolveEffectiveRepoFileListing(config, preset),
      onProgress: options.onRepoSearchProgress,
      abortSignal: options.abortSignal,
    });
    const outputText = preset.presetKind === 'plan'
      ? buildPlanMarkdownFromRepoSearch(prompt, repoRoot, result)
      : buildRepoSearchMarkdown(prompt, repoRoot, result);
    return { outputText };
  }
}
