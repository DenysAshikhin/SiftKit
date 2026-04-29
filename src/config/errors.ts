export class StatusServerUnavailableError extends Error {
  healthUrl: string;
  operation?: string;
  serviceUrl?: string;

  constructor(
    healthUrl: string,
    options: {
      cause?: unknown;
      operation?: string;
      serviceUrl?: string;
    } = {},
  ) {
    super(
      `SiftKit status/config server is not reachable at ${healthUrl}. `
      + 'Start the separate server process and stop issuing further siftkit commands until it is available.',
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'StatusServerUnavailableError';
    this.healthUrl = healthUrl;
    if (options.operation) {
      this.operation = options.operation;
    }
    if (options.serviceUrl) {
      this.serviceUrl = options.serviceUrl;
    }
  }
}

export class MissingObservedBudgetError extends Error {
  constructor(
    message = 'SiftKit status server did not provide usable input character/token totals. '
      + 'Refusing to derive chunk budgets from the hardcoded fallback; '
      + 'run at least one successful request or fix status metrics first.'
  ) {
    super(message);
    this.name = 'MissingObservedBudgetError';
  }
}
