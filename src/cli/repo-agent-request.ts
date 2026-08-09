import { readImageFileDataUrl } from '../llm-protocol/image-attachments.js';
import {
  RepoAgentStartRequestSchema,
  type RepoAgentStartRequest,
} from '../repo-agent/api-schemas.js';
import type { ApprovalMode } from '../repo-search/engine/approval-gate.js';

export function buildRepoAgentServerRequest(input: {
  task: string;
  repoRoot: string;
  approval: ApprovalMode;
  model?: string;
  logFile?: string;
  images: string[];
}): RepoAgentStartRequest {
  return RepoAgentStartRequestSchema.parse({
    prompt: input.task,
    repoRoot: input.repoRoot,
    approval: input.approval,
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.logFile === undefined ? {} : { logFile: input.logFile }),
    ...(input.images.length === 0
      ? {}
      : { images: input.images.map(readImageFileDataUrl) }),
  });
}
