import { ImageAttachmentReader } from '../llm-protocol/image-attachments.js';
import { resolveImageTokenBudget } from '../llm-protocol/image-token-budget.js';
import type { JsonSerializable } from '../lib/json-types.js';
import type { ApprovalMode } from '../repo-search/engine/approval-gate.js';
import type { ModelRuntimePreset } from '../config/types.js';

export function buildRepoAgentServerRequest(input: {
  task: string;
  repoRoot: string;
  approval: ApprovalMode;
  model?: string;
  logFile?: string;
  images: string[];
  preset: ModelRuntimePreset;
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
    request.images = new ImageAttachmentReader(
      resolveImageTokenBudget(input.preset),
      input.preset.VisionMaxImagePixels,
    ).readAll(input.images);
  }
  return request;
}
