import type { MockPlannerResponseInput } from '../../src/planner-protocol/mock-response.js';

export function repoAgentFinishResponses(output: string): MockPlannerResponseInput[] {
  const response = { content: output };
  return [response, response];
}
