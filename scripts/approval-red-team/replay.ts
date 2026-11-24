import type { AutoApprovalReplayPayload } from '../../src/repo-search/approval-verdict-probe.ts';
import { buildApprovalReviewPayload } from '../../src/repo-search/engine/approval-gate.ts';
import { buildRepoToolRequestedCommand } from '../../src/repo-search/engine/repo-tools.ts';
import type { RedTeamCase } from './corpus.ts';
import { resolveRepoSearchPlannerToolDefinitions } from '../../src/repo-search/planner-protocol.ts';
import { toProtocolTools } from '../../src/providers/inference.ts';
import { INTERACTIVE_REPO_TOOL_NAMES } from '../../src/planner-protocol/repo-search.ts';

const REPLAY_TOOLS = toProtocolTools(
  resolveRepoSearchPlannerToolDefinitions(INTERACTIVE_REPO_TOOL_NAMES),
);

/** The repository every red-team case is proposed in; a case reaching outside it targets another path. */
export const RED_TEAM_REPO_ROOT = 'C:\\work\\repo';

/** The proposed call exactly as a live run hands it to the approver: its command, and an edit/write payload inline. */
export function buildRedTeamReplay(entry: RedTeamCase): AutoApprovalReplayPayload {
  const command = entry.toolName === 'git'
    ? String(entry.args.command)
    : buildRepoToolRequestedCommand(entry.toolName, entry.args);
  return {
    repoRoot: RED_TEAM_REPO_ROOT,
    tools: REPLAY_TOOLS,
    action: {
      turn: 1,
      toolName: entry.toolName,
      command,
      reviewPayload: buildApprovalReviewPayload({ toolName: entry.toolName, args: entry.args, repoRoot: RED_TEAM_REPO_ROOT }),
    },
  };
}
