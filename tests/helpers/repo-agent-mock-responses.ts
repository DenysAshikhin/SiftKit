export function repoAgentFinishResponses(output: string): string[] {
  const response = JSON.stringify({ action: 'finish', output });
  return [response, response];
}
