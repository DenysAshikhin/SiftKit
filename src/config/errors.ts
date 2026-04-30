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
    const context = [
      options.operation ? `Operation: ${options.operation}.` : '',
      options.serviceUrl ? `Service URL: ${options.serviceUrl}.` : '',
      options.cause === undefined ? '' : `Cause: ${options.cause instanceof Error ? options.cause.message : String(options.cause)}.`,
    ].filter(Boolean).join(' ');
    super([
      `SiftKit status/config server is not reachable at ${healthUrl}.`,
      context,
      'Start the separate server process and stop issuing further siftkit commands until it is available.',
    ].filter(Boolean).join(' '), options.cause === undefined ? undefined : { cause: options.cause });
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
