import { getActiveModelPreset } from '../config/index.js';
import type { SiftConfig } from '../config/types.js';
import type { SiftPreset } from '../presets.js';
import { PresetCatalog } from '../preset-catalog.js';
import { resolveRunSystemPrompt, type RunSystemPromptSurface } from '../repo-search/run-system-prompt.js';
import type { ChatSession } from '../state/chat-sessions.js';
import { resolveChatRunAllowedTools } from './chat-operation-preset.js';
import { buildChatSystemContent, resolveChatPreviewConfig } from './chat.js';
import { PresetSystemContextBuilder } from '../preset-system-context.js';

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

/** The prompt kind each launch path uses, with the tools that same path offers. */
function resolvePromptSurface(config: SiftConfig, session: ChatSession, preset: SiftPreset): RunSystemPromptSurface {
  if (preset.presetKind === 'repo-agent') return { promptKind: 'repo-agent', allowedTools: resolveChatRunAllowedTools({ operation: 'repo-agent' }) };
  if (preset.presetKind === 'plan' || preset.presetKind === 'repo-search') {
    return { promptKind: 'planner', allowedTools: resolveChatRunAllowedTools({ operation: preset.presetKind, config, preset }) };
  }
  return { promptKind: 'chat', chatSystemPrompt: buildChatSystemContent(config, session),
    allowedTools: resolveChatRunAllowedTools({ operation: 'chat', webEnabled: session.webSearchEnabled === true }) };
}

export function buildChatPromptContext(config: SiftConfig, session: ChatSession): ChatPromptContext {
  const presets = PresetCatalog.fromPresets(config.Presets);
  const presetId = typeof session.presetId === 'string' ? session.presetId.trim() : '';
  if (!presetId) {
    throw new Error('Chat session presetId is required.');
  }
  const preset = presets.requireById(presetId);
  // Resolved like the next run's admission would be, so the preview shows the model it would use.
  const effectiveConfig = resolveChatPreviewConfig(config, session);
  // Every path goes through the resolver the engine itself calls, so this panel cannot drift from the run.
  const { systemPrompt, toolDefinitions } = resolveRunSystemPrompt({
    ...resolvePromptSurface(effectiveConfig, session, preset),
    promptPrefix: preset.promptPrefix,
    systemContext: new PresetSystemContextBuilder(session.planRepoRoot).build(preset),
    webSearch: effectiveConfig.WebSearch,
    webToolsEnabled: session.webSearchEnabled === true,
    visionEnabled: getActiveModelPreset(effectiveConfig).VisionEnabled === true,
    webChatTools: true,
  });
  return {
    id: `${String(session.id || 'session')}:system-context`,
    role: 'system',
    kind: 'system_context',
    label: 'System prompt and tool schema',
    content: [
      formatSection('System prompt', systemPrompt),
      formatSection('Tool schema', JSON.stringify(toolDefinitions, null, 2)),
    ].join('\n\n'),
    createdAtUtc: typeof session.createdAtUtc === 'string' && session.createdAtUtc.trim()
      ? session.createdAtUtc
      : new Date().toISOString(),
    deletable: false,
  };
}
