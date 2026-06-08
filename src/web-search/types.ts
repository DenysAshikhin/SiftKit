export type WebSearchProviderId = 'brave';

export type WebSearchConfig = {
  EnabledDefault: boolean;
  Provider: WebSearchProviderId;
  BraveApiKey: string;
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
