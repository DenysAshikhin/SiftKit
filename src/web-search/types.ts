export type WebSearchProviderId = 'tavily' | 'firecrawl';

export type WebSearchProviderSettings = {
  Enabled: boolean;
  ApiKey: string;
};

export type WebSearchConfig = {
  EnabledDefault: boolean;
  Providers: Record<WebSearchProviderId, WebSearchProviderSettings>;
  ProviderOrder: WebSearchProviderId[];
  ResultCount: number;
  FetchMaxPages: number;
  TimeoutMs: number;
  FetchMaxCharacters: number;
};

export type WebSearchToolArgs = {
  query: string;
  timeFilter?: 'day' | 'week' | 'month' | 'year';
};

export type WebFetchToolArgs = {
  url: string;
};

export type WebToolArgs = WebSearchToolArgs | WebFetchToolArgs;

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
  source: WebSearchProviderId;
};

export type ProviderQuota = {
  provider: WebSearchProviderId;
  used: number | null;
  limit: number | null;
  remaining: number | null;
};

export type WebFetchResult = {
  url: string;
  finalUrl: string;
  title: string;
  text: string;
  truncated: boolean;
};

export type WebToolExecutionResult = {
  command: string;
  output: string;
  outputTokens: number | null;
};
