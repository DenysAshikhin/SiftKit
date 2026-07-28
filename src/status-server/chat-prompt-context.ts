import type { SiftConfig } from '../config/types.js';
import {
  findPresetById,
  mapLegacyModeToPresetId,
  normalizeOperationModeAllowedTools,
  normalizePresets,
  resolvePresetAllowedTools,
  type SiftPreset,
} from '../presets.js';
import { resolveRepoSearchPlannerToolDefinitions } from '../repo-search/planner-protocol.js';
import { buildTaskSystemPrompt } from '../repo-search/prompts.js';
import type { ChatSession } from '../state/chat-sessions.js';
import { buildChatSystemContent } from './chat.js';
import { PresetSystemContextBuilder, type PresetSystemContext } from '../preset-system-context.js';

export type ChatPromptContext = {
  id: string;
  role: 'system';
  kind: 'system_context';
  label: string;
  content: string;
  createdAtUtc: string;
  deletable: false;
};

type PromptContextOptions = {
  promptPrefix?: string;
};

function normalizeChatMode(value: string | null | undefined): 'chat' | 'plan' | 'repo-search' {
  return value === 'plan' || value === 'repo-search' ? value : 'chat';
}

function readPromptPrefix(preset: SiftPreset | null, options: PromptContextOptions): string {
  if (typeof options.promptPrefix === 'string' && options.promptPrefix.trim()) {
    return options.promptPrefix.trim();
  }
  return typeof preset?.promptPrefix === 'string' ? preset.promptPrefix.trim() : '';
}

function readRepoRoot(session: ChatSession): string {
  return typeof session.planRepoRoot === 'string' && session.planRepoRoot.trim()
    ? session.planRepoRoot.trim()
    : process.cwd();
}

function formatSection(title: string, content: string): string {
  return [`## ${title}`, '', content.trim()].join('\n');
}

function buildRepoToolPromptContextContent(
  config: SiftConfig,
  preset: SiftPreset,
  promptPrefix: string,
  systemContext: PresetSystemContext,
): string {
  const allowedTools = resolvePresetAllowedTools(
    preset,
    normalizeOperationModeAllowedTools(config.OperationModeAllowedTools),
  );
  const systemPrompt = buildTaskSystemPrompt(systemContext);
  const toolDefinitions = resolveRepoSearchPlannerToolDefinitions(allowedTools);
  return [
    formatSection('System prompt', systemPrompt),
    ...(promptPrefix ? [formatSection('Preset prompt prefix', promptPrefix)] : []),
    formatSection('Tool schema', JSON.stringify(toolDefinitions, null, 2)),
  ].join('\n\n');
}

function buildDirectPromptContextContent(
  config: SiftConfig,
  session: ChatSession,
  promptPrefix: string,
  systemContext: PresetSystemContext,
): string {
  const content = [
    buildChatSystemContent(config, session, { promptPrefix }),
    systemContext.content,
  ].filter(Boolean).join('\n\n');
  return formatSection('System prompt', content);
}

export function buildChatPromptContext(config: SiftConfig, session: ChatSession, options: PromptContextOptions = {}): ChatPromptContext {
  const presets = normalizePresets(config.Presets);
  const presetId = typeof session.presetId === 'string' && session.presetId.trim()
    ? session.presetId.trim()
    : mapLegacyModeToPresetId(session.mode);
  const preset = findPresetById(presets, presetId);
  if (!preset) {
    throw new Error(`Chat preset '${presetId}' was not found.`);
  }
  const mode = normalizeChatMode(session.mode);
  const promptPrefix = readPromptPrefix(preset, options);
  const systemContext = new PresetSystemContextBuilder(readRepoRoot(session)).build(preset);
  const content = mode === 'plan' || mode === 'repo-search'
    ? buildRepoToolPromptContextContent(config, preset, promptPrefix, systemContext)
    : buildDirectPromptContextContent(config, session, promptPrefix, systemContext);
  return {
    id: `${String(session.id || 'session')}:system-context`,
    role: 'system',
    kind: 'system_context',
    label: mode === 'plan' || mode === 'repo-search' ? 'System prompt and tool schema' : 'System prompt',
    content,
    createdAtUtc: typeof session.createdAtUtc === 'string' && session.createdAtUtc.trim()
      ? session.createdAtUtc
      : new Date().toISOString(),
    deletable: false,
  };
}
