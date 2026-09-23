import type { PlannerToolDefinition } from '../planner-protocol/json-schema.js';
import { WEB_CHAT_TOOL_NAMES } from '../planner-protocol/repo-search.js';
import type { PresetSystemContext } from '../preset-system-context.js';
import { PresetSystemPromptComposer } from '../preset-system-prompt.js';
import { applyWebToolPolicy, resolveWebToolPolicy } from '../web-search/tool-policy.js';
import type { WebSearchConfig } from '../web-search/types.js';
import { resolveRepoSearchPlannerToolDefinitions } from './planner-protocol.js';
import {
  buildAgentSystemPrompt,
  buildOrchestratorSystemPrompt,
  buildTaskSystemPrompt,
  buildWebChatToolInstructions,
} from './prompts.js';

type RunSystemPromptBase = {
  promptPrefix: string;
  additionalPromptPrefix?: string;
  systemContext: PresetSystemContext;
  webSearch: WebSearchConfig;
  /** Explicit per-run web intent; `undefined` defers to `WebSearch.EnabledDefault`. */
  webToolsEnabled: boolean | undefined;
  visionEnabled: boolean;
  /** True only for runs bound to a durable web chat. */
  webChatTools: boolean;
};

/** `chat` supplies its own base prompt; the other kinds derive one from the resolved tool surface. */
export type RunSystemPromptSurface =
  | { promptKind: 'repo-agent' | 'planner' | 'orchestrator'; allowedTools: readonly string[] }
  | { promptKind: 'chat'; chatSystemPrompt: string; allowedTools: readonly string[] };

export type RunSystemPromptRequest = RunSystemPromptBase & RunSystemPromptSurface;

export type ResolvedRunSystemPrompt = {
  systemPrompt: string;
  toolDefinitions: PlannerToolDefinition[];
};

/**
 * The single definition of what a run is told and which tools it is offered. The engine composes
 * the prompt it sends from here, and the chat prompt-context panel renders the same call for the
 * same session, so the preview cannot describe a surface the run never sees.
 */
export function resolveRunSystemPrompt(request: RunSystemPromptRequest): ResolvedRunSystemPrompt {
  const allowedTools = request.webChatTools ? [...request.allowedTools, ...WEB_CHAT_TOOL_NAMES] : request.allowedTools;
  const toolDefinitions = resolveRepoSearchPlannerToolDefinitions(
    applyWebToolPolicy(
      allowedTools,
      resolveWebToolPolicy(request.webSearch, request.webToolsEnabled),
    ),
    request.visionEnabled,
  );
  const baseSystemPrompt = request.promptKind === 'chat'
    ? request.chatSystemPrompt
    : request.promptKind === 'repo-agent'
      ? buildAgentSystemPrompt(request.systemContext, toolDefinitions)
      : request.promptKind === 'orchestrator'
        ? buildOrchestratorSystemPrompt(toolDefinitions)
        : buildTaskSystemPrompt(request.systemContext, toolDefinitions);
  // One shared guidance block for the web chat tools, whatever base prompt the run kind uses.
  const webChatToolInstructions = buildWebChatToolInstructions(toolDefinitions.map(({ function: definition }) => definition.name));
  const systemPrompt = [baseSystemPrompt, webChatToolInstructions].filter((section) => section.length > 0).join('\n\n');
  return {
    systemPrompt: new PresetSystemPromptComposer(request.promptPrefix, request.systemContext)
      .compose(systemPrompt, request.additionalPromptPrefix),
    toolDefinitions,
  };
}
