import type { PlannerToolDefinition } from '../planner-protocol/json-schema.js';
import type { PresetSystemContext } from '../preset-system-context.js';
import { PresetSystemPromptComposer } from '../preset-system-prompt.js';
import { applyWebToolPolicy, resolveWebToolPolicy } from '../web-search/tool-policy.js';
import type { WebSearchConfig } from '../web-search/types.js';
import { resolveRepoSearchPlannerToolDefinitions } from './planner-protocol.js';
import { buildAgentSystemPrompt, buildTaskSystemPrompt } from './prompts.js';

type RunSystemPromptBase = {
  promptPrefix: string;
  additionalPromptPrefix?: string;
  systemContext: PresetSystemContext;
  allowedTools: readonly string[];
  webSearch: WebSearchConfig;
  /** Explicit per-run web intent; `undefined` defers to `WebSearch.EnabledDefault`. */
  webToolsEnabled: boolean | undefined;
  visionEnabled: boolean;
};

/** `chat` supplies its own base prompt; the other kinds derive one from the resolved tool surface. */
export type RunSystemPromptRequest =
  | (RunSystemPromptBase & { promptKind: 'repo-agent' | 'planner' })
  | (RunSystemPromptBase & { promptKind: 'chat'; chatSystemPrompt: string });

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
  const toolDefinitions = resolveRepoSearchPlannerToolDefinitions(
    applyWebToolPolicy(
      request.allowedTools,
      resolveWebToolPolicy(request.webSearch, request.webToolsEnabled),
    ),
    request.visionEnabled,
  );
  const baseSystemPrompt = request.promptKind === 'chat'
    ? request.chatSystemPrompt
    : request.promptKind === 'repo-agent'
      ? buildAgentSystemPrompt(request.systemContext, toolDefinitions)
      : buildTaskSystemPrompt(request.systemContext, toolDefinitions);
  return {
    systemPrompt: new PresetSystemPromptComposer(request.promptPrefix, request.systemContext)
      .compose(baseSystemPrompt, request.additionalPromptPrefix),
    toolDefinitions,
  };
}
