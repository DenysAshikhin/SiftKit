import type { PlannerToolDefinition } from '../planner-protocol/json-schema.ts';
import { BACKGROUND_JOB_TOOL_NAME, ORCHESTRATOR_TOOL_NAMES, WEB_CHAT_TOOL_NAMES } from '../planner-protocol/repo-search.ts';
import type { PresetSystemContext } from '../preset-system-context.ts';
import { PresetSystemPromptComposer } from '../preset-system-prompt.ts';
import { applyWebToolPolicy, resolveWebToolPolicy } from '../web-search/tool-policy.ts';
import type { WebSearchConfig } from '../web-search/types.ts';
import { resolveRepoSearchPlannerToolDefinitions } from './planner-protocol.ts';
import {
  buildAgentSystemPrompt,
  buildBackgroundJobInstructions,
  buildOrchestratorSystemPrompt,
  buildTaskSystemPrompt,
  buildWebChatToolInstructions,
} from './prompts.ts';

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
  /** The run owns background jobs, so its `run` comes with `job`. */
  backgroundJobs: boolean;
  /** An orchestrator parent is offered its own host tools on top of its repository tools. */
  orchestratorTools: boolean;
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
  const allowedTools = [
    ...request.allowedTools,
    ...(request.backgroundJobs && request.allowedTools.includes('run') ? [BACKGROUND_JOB_TOOL_NAME] : []),
    ...(request.webChatTools ? WEB_CHAT_TOOL_NAMES : []),
    ...(request.orchestratorTools ? ORCHESTRATOR_TOOL_NAMES : []),
  ];
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
  // Shared guidance blocks for tools that ride on a surface, whatever base prompt the run kind uses.
  const toolNames = toolDefinitions.map(({ function: definition }) => definition.name);
  const systemPrompt = [baseSystemPrompt, buildBackgroundJobInstructions(toolNames), buildWebChatToolInstructions(toolNames)].filter((section) => section.length > 0).join('\n\n');
  return {
    systemPrompt: new PresetSystemPromptComposer(request.promptPrefix, request.systemContext)
      .compose(systemPrompt, request.additionalPromptPrefix),
    toolDefinitions,
  };
}
