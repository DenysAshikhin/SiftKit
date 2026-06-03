export function buildLiveToolMessageId(toolCallId: string): string {
  if (!toolCallId) throw new Error('toolCallId required for live tool message id');
  return `live-tool-${toolCallId}`;
}
