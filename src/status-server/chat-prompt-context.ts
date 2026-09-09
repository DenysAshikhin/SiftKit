import { getActiveModelPreset } from '../config/index.js';
import type { SiftConfig } from '../config/types.js';
import { INTERACTIVE_REPO_TOOL_NAMES } from '../planner-protocol/repo-search.js';
import type { PresetKind, SiftPreset } from '../presets.js';
import { PresetCatalog } from '../preset-catalog.js';
import { resolveRunSystemPrompt } from '../repo-search/run-system-prompt.js';
import type { ChatSession } from '../state/chat-sessions.js';
import { buildChatOperationAllowedTools } from './chat-operation-preset.js';
import { buildChatSystemContent, resolveChatSessionConfig } from './chat.js';
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

function isRepoToolPresetKind(presetKind: PresetKind): boolean {
  return presetKind === 'plan' || presetKind === 'repo-search' || presetKind === 'repo-agent';
}

function buildRepoToolPromptContextContent(
  config: SiftConfig,
  session: ChatSession,
  preset: SiftPreset,
  systemContext: PresetSystemContext,
): string {
  // Only the tool surface differs between the launch paths: repo-agent runs go through
  // startRepoAgentRun with the fixed interactive surface, plan/repo-search runs go through
  // ChatRepoOperationRunner with the preset surface. Everything else comes from the resolver the
  // engine itself calls, so this panel cannot drift from the run.
  const isAgent = preset.presetKind === 'repo-agent';
  const { systemPrompt, toolDefinitions } = resolveRunSystemPrompt({
    promptKind: isAgent ? 'repo-agent' : 'planner',
    promptPrefix: preset.promptPrefix,
    systemContext,
    allowedTools: isAgent
      ? [...INTERACTIVE_REPO_TOOL_NAMES]
      : buildChatOperationAllowedTools(config, preset),
    webSearch: config.WebSearch,
    webToolsEnabled: session.webSearchEnabled === true,
    visionEnabled: getActiveModelPreset(config).VisionEnabled === true,
  });
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
  // The run reads the session's model preset overlay, so the preview must resolve against the
  // same effective config rather than the raw one.
  const effectiveConfig = resolveChatSessionConfig(config, session);
  const repoToolPreset = isRepoToolPresetKind(preset.presetKind);
  const systemContext = new PresetSystemContextBuilder(session.planRepoRoot).build(preset);
  const content = repoToolPreset
    ? buildRepoToolPromptContextContent(effectiveConfig, session, preset, systemContext)
    : buildDirectPromptContextContent(effectiveConfig, session, preset, systemContext);
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
