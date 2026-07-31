import { ImageAttachmentReader } from '../llm-protocol/image-attachments.js';
import type { JsonSerializable } from '../lib/json-types.js';
import type { ApprovalMode } from '../repo-search/engine/approval-gate.js';

export function buildRepoAgentServerRequest(input: {
  task: string;
  repoRoot: string;
  approval: ApprovalMode;
  model?: string;
  logFile?: string;
  images: string[];
}): Record<string, JsonSerializable> {
  const request: Record<string, JsonSerializable> = {
    prompt: input.task,
    repoRoot: input.repoRoot,
    approval: input.approval,
  };
  if (input.model !== undefined) {
    request.model = input.model;
  }
  if (input.logFile !== undefined) {
    request.logFile = input.logFile;
  }
  if (input.images.length > 0) {
    request.images = new ImageAttachmentReader().readAll(input.images);
  }
  return request;
}
