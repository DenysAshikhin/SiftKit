export type ChatGroundingStatus = 'ungrounded' | 'snippet_only' | 'fetched';

export type ChatGroundingToolResult = {
  toolName: string;
  command: string;
  exitCode: number;
  output: string;
};

export type ChatGroundingFinishDecision =
  | { kind: 'allow' }
  | { kind: 'reject'; message: string };

type ChatGroundingPolicyOptions = {
  enabled: boolean;
  maxFinishRejections?: number;
};

const DEFAULT_MAX_FINISH_REJECTIONS = 3;

export const CHAT_GROUNDING_FINAL_ANSWER_INSTRUCTION = [
  'Grounding policy for web-enabled chat:',
  '- Treat web_search results as leads only, not as claim-level evidence.',
  '- Use fetched page text as the source of truth for factual claims.',
  '- Do not include concrete factual claims that are not supported by fetched evidence.',
  '- If fetched evidence is unavailable or conflicts, say the answer is limited by available evidence.',
].join('\n');

export class ChatGroundingPolicy {
  private readonly enabled: boolean;
  private readonly maxFinishRejections: number;
  private searchSucceeded = false;
  private fetchSucceeded = false;
  private finishRejections = 0;

  constructor(options: ChatGroundingPolicyOptions) {
    this.enabled = options.enabled === true;
    this.maxFinishRejections = Math.max(0, Math.trunc(Number(options.maxFinishRejections ?? DEFAULT_MAX_FINISH_REJECTIONS)));
  }

  recordToolResult(result: ChatGroundingToolResult): void {
    if (!this.enabled) {
      return;
    }
    const toolName = String(result.toolName || '').trim();
    const output = String(result.output || '').trim();
    const succeeded = Number(result.exitCode) === 0 && output.length > 0;
    if (!succeeded) {
      return;
    }
    if (toolName === 'web_search') {
      this.searchSucceeded = true;
      return;
    }
    if (toolName === 'web_fetch') {
      this.fetchSucceeded = true;
    }
  }

  evaluateFinish(): ChatGroundingFinishDecision {
    if (!this.enabled || !this.searchSucceeded || this.fetchSucceeded) {
      return { kind: 'allow' };
    }
    if (this.finishRejections >= this.maxFinishRejections) {
      return { kind: 'allow' };
    }
    this.finishRejections += 1;
    return { kind: 'reject', message: this.buildFinishRejectionMessage() };
  }

  buildDuplicateSearchMessage(): string {
    return [
      'Rejected: duplicate web_search after prior web results.',
      'Do not repeat the same search.',
      'Use web_fetch on the best returned URL, or issue a materially different web_search query if the results are poor.',
    ].join(' ');
  }

  getStatus(): ChatGroundingStatus {
    if (!this.enabled || !this.searchSucceeded) {
      return 'ungrounded';
    }
    if (!this.fetchSucceeded) {
      return 'snippet_only';
    }
    return 'fetched';
  }

  private buildFinishRejectionMessage(): string {
    return [
      'Do not answer from search snippets.',
      'You ran web_search but have not successfully fetched a source page.',
      'Use {"action":"tool","tool_name":"web_fetch","args":{"url":"<one returned URL>"}} before answering, or run a different web_search if the results were poor.',
      'If fetching is impossible after the retry budget, answer only with the limitation that fetched evidence was unavailable.',
    ].join(' ');
  }
}
