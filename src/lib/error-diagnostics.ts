export type ErrorDiagnostic = {
  name: string;
  message: string;
  stack?: string;
  operation?: string;
  serviceUrl?: string;
  healthUrl?: string;
  cause?: ErrorDiagnostic;
};

function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function getStringProperty(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function serializeErrorDiagnostic(error: unknown): ErrorDiagnostic {
  const record = getRecord(error);
  const name = error instanceof Error
    ? error.name
    : getStringProperty(record ?? {}, 'name') ?? 'Error';
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : getStringProperty(record ?? {}, 'message') ?? String(error);
  const diagnostic: ErrorDiagnostic = { name, message };
  const stack = error instanceof Error ? error.stack : getStringProperty(record ?? {}, 'stack');
  if (stack) {
    diagnostic.stack = stack;
  }
  if (record) {
    const operation = getStringProperty(record, 'operation');
    const serviceUrl = getStringProperty(record, 'serviceUrl');
    const healthUrl = getStringProperty(record, 'healthUrl');
    if (operation) diagnostic.operation = operation;
    if (serviceUrl) diagnostic.serviceUrl = serviceUrl;
    if (healthUrl) diagnostic.healthUrl = healthUrl;
    if (record.cause !== undefined) {
      diagnostic.cause = serializeErrorDiagnostic(record.cause);
    }
  }
  return diagnostic;
}

export function getPrimaryCauseDiagnostic(diagnostic: ErrorDiagnostic): ErrorDiagnostic | null {
  let current = diagnostic.cause ?? null;
  while (current?.cause) {
    current = current.cause;
  }
  return current;
}
