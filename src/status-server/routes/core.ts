/** Core API route table and dispatcher. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServerContext } from '../server-types.js';
import { RouteTable } from '../route-table.js';
import {
  HealthEndpoint,
  StatusReadEndpoint,
  EngineConfigTestEndpoint,
  ConfigReadEndpoint,
  ConfigUpdateEndpoint,
  StatusRestartEndpoint,
  InferenceRuntimeReadEndpoint,
  ModelResidencyEndpoint,
} from './server-admin.js';
import {
  CommandOutputAnalyzeEndpoint,
  PresetListEndpoint,
  PresetRunEndpoint,
  EvalRunEndpoint,
  SummaryEndpoint,
} from './operations.js';
import { RepoSearchEndpoint, RepoSearchApprovalEndpoint } from './repo-search.js';
import {
  RepoAgentStartEndpoint,
  RepoAgentDecideEndpoint,
  RepoAgentStatusEndpoint,
} from './repo-agent.js';
import { StatusCompleteEndpoint, StatusPostEndpoint } from './status-post.js';

const STATUS_POST_ENDPOINT = new StatusPostEndpoint();

const CORE_ROUTES = new RouteTable([
  { method: 'GET', path: '/health', endpoint: new HealthEndpoint() },
  { method: 'GET', path: '/status', endpoint: new StatusReadEndpoint() },
  { method: 'GET', path: '/runtime/inference', endpoint: new InferenceRuntimeReadEndpoint() },
  { method: 'POST', path: '/command-output/analyze', endpoint: new CommandOutputAnalyzeEndpoint() },
  { method: 'GET', path: '/preset/list', endpoint: new PresetListEndpoint() },
  { method: 'POST', path: '/preset/run', endpoint: new PresetRunEndpoint() },
  { method: 'POST', path: '/eval/run', endpoint: new EvalRunEndpoint() },
  { method: 'POST', path: '/repo-search/approval', endpoint: new RepoSearchApprovalEndpoint() },
  { method: 'POST', path: '/repo-search', endpoint: new RepoSearchEndpoint() },
  { method: 'POST', path: '/repo-agent', endpoint: new RepoAgentStartEndpoint() },
  { method: 'POST', path: '/repo-agent/decide', endpoint: new RepoAgentDecideEndpoint() },
  { method: 'GET', path: /^\/repo-agent\/status(?:\?.*)?$/u, endpoint: new RepoAgentStatusEndpoint() },
  { method: 'POST', path: '/summary', endpoint: new SummaryEndpoint() },
  { method: 'POST', path: /^\/status\/complete(?:\?.*)?$/u, endpoint: new StatusCompleteEndpoint() },
  { method: 'POST', path: '/status', endpoint: STATUS_POST_ENDPOINT },
  { method: 'POST', path: /^\/status\/terminal-metadata(?:\?.*)?$/u, endpoint: STATUS_POST_ENDPOINT },
  { method: 'POST', path: /^\/config\/engine\/test(?:\?.*)?$/u, endpoint: new EngineConfigTestEndpoint() },
  { method: 'GET', path: /^\/config(?:\?.*)?$/u, endpoint: new ConfigReadEndpoint() },
  { method: 'PUT', path: /^\/config(?:\?.*)?$/u, endpoint: new ConfigUpdateEndpoint() },
  { method: 'POST', path: '/status/restart', endpoint: new StatusRestartEndpoint() },
  { method: 'POST', path: '/runtime/model/load', endpoint: new ModelResidencyEndpoint('load') },
  { method: 'POST', path: '/runtime/model/unload', endpoint: new ModelResidencyEndpoint('unload') },
  { method: 'POST', path: '/runtime/model/freeze', endpoint: new ModelResidencyEndpoint('freeze') },
]);

export async function handleCoreRoute(
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  return await CORE_ROUTES.handle(ctx, req, res, req.url || '/');
}
