import type { SiftConfig } from '../config/types.js';
import {
  mapLegacyModeToPresetId,
  normalizeOperationModeAllowedTools,
  normalizePresets,
  requirePresetById,
  resolvePresetAllowedTools,
  type SiftPreset,
} from '../presets.js';
import { resolveRepoSearchPlannerToolDefinitions } from '../repo-search/planner-protocol.js';
import { buildTaskSystemPrompt } from '../repo-search/prompts.js';
import type { ChatSession } from '../state/chat-sessions.js';
import { buildChatSystemContent } from './chat.js';
import { PresetSystemContextBuilder, type PresetSystemContext } from '../preset-system-context.js';
import { PresetSystemPromptComposer } from '../preset-system-prompt.js';

export type ChatPromptContext = {
  id: string;
  role: 'system';
  kind: 'system_context';
  label: string;
  content: string;
  createdAtUtc: string;
  deletable: false;
};

function normalizeChatMode(value: string | null | undefined): 'chat' | 'plan' | 'repo-search' {
  return value === 'plan' || value === 'repo-search' ? value : 'chat';
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
  systemContext: PresetSystemContext,
): string {
  const allowedTools = resolvePresetAllowedTools(
    preset,
    normalizeOperationModeAllowedTools(config.OperationModeAllowedTools),
  );
  const systemPrompt = new PresetSystemPromptComposer(
    preset.promptPrefix,
    systemContext,
  ).compose(buildTaskSystemPrompt(systemContext));
  const toolDefinitions = resolveRepoSearchPlannerToolDefinitions(allowedTools);
  return [
    formatSection('System prompt', systemPrompt),
    formatSection('Tool schema', JSON.stringify(toolDefinitions, null, 2)),
  ].join('\n\n');
}

function buildDirectPromptContextContent(
  config: SiftConfig,
  session: ChatSession,
  preset: SiftPreset,
  systemContext: PresetSystemContext,
): string {
  const content = new PresetSystemPromptComposer(
    preset.promptPrefix,
    systemContext,
  ).compose(buildChatSystemContent(config, session));
  return formatSection('System prompt', content);
}

export function buildChatPromptContext(config: SiftConfig, session: ChatSession): ChatPromptContext {
  const presets = normalizePresets(config.Presets);
  const presetId = typeof session.presetId === 'string' && session.presetId.trim()
    ? session.presetId.trim()
    : mapLegacyModeToPresetId(session.mode);
  const preset = requirePresetById(presets, presetId);
  const mode = normalizeChatMode(session.mode);
  const systemContext = new PresetSystemContextBuilder(readRepoRoot(session)).build(preset);
  const content = mode === 'plan' || mode === 'repo-search'
    ? buildRepoToolPromptContextContent(config, preset, systemContext)
    : buildDirectPromptContextContent(config, session, preset, systemContext);
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
