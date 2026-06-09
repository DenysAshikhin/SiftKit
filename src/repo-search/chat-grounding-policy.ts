import {
  parseWebToolCommand,
  type RetainedWebToolCall,
} from '../web-search/web-tool-command.js';

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

export type ChatGroundingToolDecision =
  | { kind: 'allow' }
  | { kind: 'reject'; message: string };

type ChatGroundingPolicyOptions = {
  enabled: boolean;
  maxFinishRejections?: number;
  retainedWebToolCalls?: RetainedWebToolCall[];
};

const DEFAULT_MAX_FINISH_REJECTIONS = 3;

export const CHAT_GROUNDING_FINAL_ANSWER_INSTRUCTION = [
  'Grounding policy for web-enabled chat:',
  '- Run web_search before answering. Web-enabled chat is not allowed to answer from memory alone.',
  '- Treat web_search results as leads only, not as claim-level evidence.',
  '- Use fetched page text as the source of truth for factual claims.',
  '- Do not include concrete factual claims that are not supported by fetched evidence.',
  '- If fetched evidence is unavailable or conflicts, say the answer is limited by available evidence.',
].join('\n');

export class ChatGroundingPolicy {
  private readonly enabled: boolean;
  private readonly maxFinishRejections: number;
  private readonly candidateUrls: string[] = [];
  private readonly searchedQueries = new Set<string>();
  private readonly fetchedUrls = new Set<string>();
  private searchSucceeded = false;
  private fetchSucceeded = false;
  private finishRejections = 0;

  constructor(options: ChatGroundingPolicyOptions) {
    this.enabled = options.enabled === true;
    this.maxFinishRejections = Math.max(0, Math.trunc(Number(options.maxFinishRejections ?? DEFAULT_MAX_FINISH_REJECTIONS)));
    for (const call of options.retainedWebToolCalls || []) {
      const command = call.command || (
        call.toolName === 'web_search'
          ? `web_search query=${JSON.stringify(call.value)}`
          : `web_fetch url=${JSON.stringify(call.value)}`
      );
      const exitCode = Number.isFinite(Number(call.exitCode)) ? Number(call.exitCode) : null;
      const output = typeof call.output === 'string' ? call.output : '';
      if (exitCode === 0 && output.trim()) {
        this.recordToolResult({
          toolName: call.toolName,
          command,
          exitCode,
          output,
        });
      }
    }
  }

  evaluateToolCall(toolName: string, args: Record<string, unknown>): ChatGroundingToolDecision {
    if (!this.enabled) {
      return { kind: 'allow' };
    }
    if (toolName === 'web_search') {
      const query = this.normalizeSearchQuery(String(args.query || ''));
      if (!query) {
        return { kind: 'allow' };
      }
      if (this.searchedQueries.has(query)) {
        return {
          kind: 'reject',
          message: `Rejected: already searched "${query}". Use web_fetch on a retained result URL or search a materially different query.`,
        };
      }
      return { kind: 'allow' };
    }
    if (toolName === 'web_fetch') {
      const url = this.normalizeFetchUrl(String(args.url || ''));
      if (!url) {
        return { kind: 'allow' };
      }
      if (this.fetchedUrls.has(url)) {
        return { kind: 'reject', message: `Rejected: already fetched ${url}. Use the retained page evidence or fetch a different URL.` };
      }
    }
    return { kind: 'allow' };
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
      const candidateUrls = this.extractCandidateUrls(output);
      if (candidateUrls.length === 0) {
        return;
      }
      this.searchSucceeded = true;
      const parsed = parseWebToolCommand(result.command);
      if (parsed?.toolName === 'web_search') {
        this.searchedQueries.add(this.normalizeSearchQuery(parsed.value));
      }
      this.rememberCandidateUrls(candidateUrls);
      return;
    }
    if (toolName === 'web_fetch') {
      this.fetchSucceeded = true;
      const parsed = parseWebToolCommand(result.command);
      if (parsed?.toolName === 'web_fetch') {
        this.fetchedUrls.add(this.normalizeFetchUrl(parsed.value));
      }
    }
  }

  evaluateFinish(): ChatGroundingFinishDecision {
    if (!this.enabled || this.fetchSucceeded) {
      return { kind: 'allow' };
    }
    if (this.finishRejections >= this.maxFinishRejections) {
      return { kind: 'allow' };
    }
    this.finishRejections += 1;
    if (!this.searchSucceeded) {
      return { kind: 'reject', message: this.buildSearchRequiredMessage() };
    }
    return { kind: 'reject', message: this.buildFinishRejectionMessage() };
  }

  getFetchCandidateUrls(): string[] {
    return [...this.candidateUrls].sort((left, right) => this.scoreUrl(right) - this.scoreUrl(left));
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
    const bestUrl = this.getFetchCandidateUrls()[0] || '<one returned URL>';
    return [
      'Do not answer from search snippets.',
      'You ran web_search but have not successfully fetched a source page.',
      `Use {"action":"tool","tool_name":"web_fetch","args":{"url":"${bestUrl}"}} before answering, or run a different web_search if the results were poor.`,
      `Recommended fetch: web_fetch url="${bestUrl}".`,
      'If fetching is impossible after the retry budget, answer only with the limitation that fetched evidence was unavailable.',
    ].join(' ');
  }

  private buildSearchRequiredMessage(): string {
    return [
      'Do not answer from memory in web-enabled chat.',
      'Run web_search for the user question before answering.',
      'Then use web_fetch on the best returned URL before making factual claims.',
      'If searching or fetching is impossible after the retry budget, answer only with the limitation that web evidence was unavailable.',
    ].join(' ');
  }

  private extractCandidateUrls(output: string): string[] {
    const urls: string[] = [];
    const matches = output.matchAll(/^URL:\s*(https?:\/\/\S+)/gimu);
    for (const match of matches) {
      const url = String(match[1] || '').trim();
      if (url) {
        urls.push(url);
      }
    }
    return urls;
  }

  private rememberCandidateUrls(urls: string[]): void {
    for (const url of urls) {
      if (!this.candidateUrls.includes(url)) {
        this.candidateUrls.push(url);
      }
    }
  }

  private normalizeSearchQuery(value: string): string {
    return String(value || '').trim().toLowerCase().replace(/\s+/gu, ' ');
  }

  private normalizeFetchUrl(value: string): string {
    try {
      const url = new URL(String(value || '').trim());
      url.hash = '';
      url.pathname = url.pathname.replace(/\/+$/u, '') || '/';
      return url.toString();
    } catch {
      return String(value || '').trim().replace(/#.*$/u, '').replace(/\/+$/u, '').toLowerCase();
    }
  }

  private scoreUrl(urlText: string): number {
    let score = 0;
    let hostname = '';
    try {
      hostname = new URL(urlText).hostname.toLowerCase();
    } catch {
      return score;
    }
    const hostnameTokens = hostname.split(/[.-]+/u).filter((token) => token.length > 0);
    if (hostnameTokens.includes('wiki')) {
      score += 20;
    }
    if (
      hostnameTokens.includes('official')
      || hostnameTokens.includes('docs')
      || hostnameTokens.includes('documentation')
      || hostnameTokens.includes('reference')
    ) {
      score += 10;
    }
    if (hostnameTokens.includes('forum') || hostnameTokens.includes('community') || hostnameTokens.includes('social')) {
      score -= 5;
    }
    if (hostnameTokens.includes('guide') || hostnameTokens.includes('blog') || hostnameTokens.includes('money')) {
      score -= 3;
    }
    return score;
  }
}
