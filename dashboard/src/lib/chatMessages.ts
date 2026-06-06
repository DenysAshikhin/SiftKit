import type {
  ChatMessage,
  ChatPromptContext,
  ChatSession,
  DashboardPreset,
  RepoSearchAutoAppendSelection,
} from '../types';

export function hashFnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16);
}

export function buildLiveMessageScrollSignature(messages: ChatMessage[]): string {
  return messages.map((message) => [
    message.id,
    message.kind || '',
    hashFnv1a32(message.content || ''),
    hashFnv1a32(message.toolCallCommand || ''),
    hashFnv1a32(message.toolCallOutputSnippet || ''),
    hashFnv1a32(message.toolCallOutput || ''),
    message.toolCallStatus || '',
    message.toolCallExitCode ?? '',
  ].join(':')).join('|');
}

export function estimatePromptTokens(content: string): number {
  return Math.max(1, Math.ceil(content.length / 4));
}

export const AGENTS_MD_PROMPT_DELIMITER = '--- agents.md (project-specific instructions) ---';

// Sections that buildRepoToolPromptContextContent appends after the system prompt,
// i.e. immediately after the trailing agents.md block. Stripping must preserve them.
const PROMPT_CONTEXT_TRAILING_SECTIONS = ['\n\n## Preset prompt prefix', '\n\n## Tool schema'];

export function stripAgentsMdBlock(content: string): string {
  const delimiterIndex = content.indexOf(AGENTS_MD_PROMPT_DELIMITER);
  if (delimiterIndex === -1) {
    return content;
  }
  const head = content.slice(0, delimiterIndex).trimEnd();
  let trailingIndex = -1;
  for (const marker of PROMPT_CONTEXT_TRAILING_SECTIONS) {
    const markerIndex = content.indexOf(marker, delimiterIndex);
    if (markerIndex !== -1 && (trailingIndex === -1 || markerIndex < trailingIndex)) {
      trailingIndex = markerIndex;
    }
  }
  if (trailingIndex === -1) {
    return head;
  }
  return `${head}\n\n${content.slice(trailingIndex + 2)}`;
}

export function buildDisplayedSystemPromptContent(
  content: string,
  showAutoAppendControls: boolean,
  selection: RepoSearchAutoAppendSelection,
): string {
  if (showAutoAppendControls && !selection.includeAgentsMd) {
    return stripAgentsMdBlock(content);
  }
  return content;
}

export function buildFallbackPromptContext(
  selectedSession: ChatSession,
  selectedChatPreset: DashboardPreset | null,
  isRepoToolMode: boolean,
  planRepoRootInput: string,
): ChatPromptContext {
  const promptPrefix = selectedChatPreset?.promptPrefix?.trim() || 'general, coder friendly assistant';
  const toolNames = Array.isArray(selectedChatPreset?.allowedTools) ? selectedChatPreset.allowedTools : [];
  const parts = [
    '## System prompt',
    '',
    promptPrefix,
  ];
  if (isRepoToolMode) {
    parts.push(
      '',
      '## Tool schema',
      '',
      JSON.stringify({
        mode: selectedChatPreset?.presetKind || selectedSession.mode || 'repo-search',
        repoRoot: planRepoRootInput || selectedSession.planRepoRoot || '',
        allowedTools: toolNames,
        includeAgentsMd: selectedChatPreset?.includeAgentsMd !== false,
        includeRepoFileListing: selectedChatPreset?.includeRepoFileListing !== false,
      }, null, 2),
    );
  }
  return {
    id: `${selectedSession.id}:system-context-fallback`,
    role: 'system',
    kind: 'system_context',
    label: isRepoToolMode ? 'System prompt and tool schema' : 'System prompt',
    content: parts.join('\n'),
    createdAtUtc: selectedSession.createdAtUtc,
    deletable: false,
  };
}
