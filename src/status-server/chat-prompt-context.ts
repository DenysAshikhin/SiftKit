import type { SiftConfig } from '../config/types.js';
import {
  normalizeOperationModeAllowedTools,
  resolvePresetAllowedTools,
  type SiftPreset,
} from '../presets.js';
import { PresetCatalog } from '../preset-catalog.js';
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

function formatSection(title: string, content: string): string {
  return [`## ${title}`, '', content.trim()].join('\n');
}

function buildRepoToolPromptContextContent(
  config: SiftConfig,
  preset: SiftPreset,
  systemContext: PresetSystemContext,
  visionEnabled: boolean,
): string {
  const allowedTools = resolvePresetAllowedTools(
    preset,
    normalizeOperationModeAllowedTools(config.OperationModeAllowedTools),
  );
  const toolDefinitions = resolveRepoSearchPlannerToolDefinitions(allowedTools, visionEnabled);
  const systemPrompt = new PresetSystemPromptComposer(
    preset.promptPrefix,
    systemContext,
  ).compose(buildTaskSystemPrompt(systemContext, toolDefinitions));
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
  const presets = PresetCatalog.fromPresets(config.Presets);
  const presetId = typeof session.presetId === 'string' ? session.presetId.trim() : '';
  if (!presetId) {
    throw new Error('Chat session presetId is required.');
  }
  const preset = presets.requireById(presetId);
  const repoToolPreset = preset.presetKind === 'plan' || preset.presetKind === 'repo-search';
  const systemContext = new PresetSystemContextBuilder(session.planRepoRoot).build(preset);
  const content = repoToolPreset
    ? buildRepoToolPromptContextContent(config, preset, systemContext, session.modelPreset.VisionEnabled === true)
    : buildDirectPromptContextContent(config, session, preset, systemContext);
  return {
    id: `${String(session.id || 'session')}:system-context`,
    role: 'system',
    kind: 'system_context',
    label: repoToolPreset ? 'System prompt and tool schema' : 'System prompt',
    content,
    createdAtUtc: typeof session.createdAtUtc === 'string' && session.createdAtUtc.trim()
      ? session.createdAtUtc
      : new Date().toISOString(),
    deletable: false,
  };
}
