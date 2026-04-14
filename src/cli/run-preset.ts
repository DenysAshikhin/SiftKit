import { getConfigPath } from '../config/index.js';
import { readConfig } from '../status-server/config-store.js';
import { findPresetById, getPresetsForSurface, normalizePresets, type SiftPreset } from '../presets.js';
import { getCommandArgs, parseArguments } from './args.js';
import { readSummaryInput, summarizeRequest } from '../summary/core.js';
import { executeRepoSearchRequest } from '../repo-search/execute.js';
import {
  buildPlanMarkdownFromRepoSearch,
  buildPlanRequestPrompt,
  buildRepoSearchMarkdown,
  generateChatAssistantMessage,
} from '../status-server/chat.js';

function getCliPreset(presetId: string): SiftPreset {
  const config = readConfig(getConfigPath());
  const presets = getPresetsForSurface(normalizePresets(config.Presets), 'cli');
  const preset = findPresetById(presets, presetId);
  if (!preset) {
    throw new Error(`Unknown CLI preset: ${presetId}`);
  }
  return preset;
}

function getPromptPrefix(config: Record<string, unknown>, preset: SiftPreset): string {
  return preset.promptPrefix.trim() || String(config.PromptPrefix || '').trim();
}

export async function runPresetCli(options: {
  argv: string[];
  stdinText?: string | Buffer;
  stdout: NodeJS.WritableStream;
}): Promise<number> {
  const parsed = parseArguments(getCommandArgs(options.argv));
  const presetId = String(parsed.preset || '').trim();
  if (!presetId) {
    throw new Error('A --preset is required.');
  }
  const config = readConfig(getConfigPath());
  const preset = getCliPreset(presetId);
  const model = parsed.model;

  if (preset.executionFamily === 'summary') {
    const question = parsed.question || parsed.positionals[0];
    if (!question) {
      throw new Error('A question is required.');
    }
    const inputText = readSummaryInput({
      text: parsed.text,
      file: parsed.file,
      stdinText: options.stdinText,
    });
    if ((!parsed.file || parsed.file.length === 0) && !inputText?.trim()) {
      throw new Error('stdin, --text or --file required');
    }
    const hasStdinInput = typeof options.stdinText === 'string'
      ? options.stdinText.trim().length > 0
      : Buffer.isBuffer(options.stdinText)
        ? options.stdinText.length > 0
        : false;
    const result = await summarizeRequest({
      question,
      inputText: inputText ?? '',
      format: parsed.format === 'json' ? 'json' : 'text',
      policyProfile: (parsed.profile as Parameters<typeof summarizeRequest>[0]['policyProfile']) || 'general',
      backend: parsed.backend,
      model,
      promptPrefix: getPromptPrefix(config, preset),
      allowedPlannerTools: preset.allowedTools.filter((toolName) => (
        toolName === 'find_text' || toolName === 'read_lines' || toolName === 'json_filter'
      )),
      sourceKind: process.env.SIFTKIT_SUMMARY_SOURCE_KIND === 'command-output' || hasStdinInput
        ? 'command-output'
        : 'standalone',
      commandExitCode: process.env.SIFTKIT_SUMMARY_COMMAND_EXIT_CODE?.trim()
        ? Number.parseInt(process.env.SIFTKIT_SUMMARY_COMMAND_EXIT_CODE, 10)
        : undefined,
    });
    options.stdout.write(`${result.Summary}\n`);
    return 0;
  }

  const prompt = String(parsed.prompt || parsed.question || parsed.positionals.join(' ')).trim();
  if (!prompt) {
    throw new Error('A prompt is required.');
  }
  if (preset.executionFamily === 'chat') {
    const runtime = (config.Runtime && typeof config.Runtime === 'object' ? config.Runtime : {}) as Record<string, unknown>;
    const runtimeLlama = (runtime.LlamaCpp && typeof runtime.LlamaCpp === 'object' ? runtime.LlamaCpp : {}) as Record<string, unknown>;
    const result = await generateChatAssistantMessage(config, {
      id: 'cli-ephemeral',
      title: preset.label,
      model: typeof runtime.Model === 'string' ? runtime.Model : null,
      contextWindowTokens: Number(runtimeLlama.NumCtx || 150000),
      thinkingEnabled: preset.thinkingEnabled !== false,
      presetId: preset.id,
      mode: 'chat',
      planRepoRoot: process.cwd(),
      condensedSummary: '',
      createdAtUtc: new Date().toISOString(),
      updatedAtUtc: new Date().toISOString(),
      messages: [],
      hiddenToolContexts: [],
    }, prompt, {
      promptPrefix: preset.promptPrefix.trim() || undefined,
    });
    options.stdout.write(`${result.assistantContent}\n`);
    return 0;
  }

  const repoRoot = String(parsed.repoRoot || parsed.path || process.cwd()).trim() || process.cwd();
  const result = await executeRepoSearchRequest({
    taskKind: preset.executionFamily === 'plan' ? 'plan' : 'repo-search',
    prompt: preset.executionFamily === 'plan' ? buildPlanRequestPrompt(prompt) : prompt,
    promptPrefix: preset.executionFamily === 'repo-search' ? preset.promptPrefix : '',
    repoRoot,
    config,
    model,
    maxTurns: Number.isFinite(parsed.maxTurns) && Number(parsed.maxTurns) > 0 ? Number(parsed.maxTurns) : preset.maxTurns ?? undefined,
    thinkingInterval: Number.isFinite(parsed.thinkingInterval) && Number(parsed.thinkingInterval) > 0
      ? Number(parsed.thinkingInterval)
      : preset.thinkingInterval ?? undefined,
    logFile: parsed.logFile,
    allowedTools: preset.allowedTools,
  });
  const output = preset.executionFamily === 'plan'
    ? buildPlanMarkdownFromRepoSearch(prompt, repoRoot, result.scorecard as Record<string, unknown>)
    : buildRepoSearchMarkdown(prompt, repoRoot, result.scorecard as Record<string, unknown>);
  options.stdout.write(`${output}\n`);
  return 0;
}
