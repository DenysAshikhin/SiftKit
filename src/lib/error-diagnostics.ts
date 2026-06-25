export type ErrorDiagnostic = {
  name: string;
  message: string;
  stack?: string;
  operation?: string;
  serviceUrl?: string;
  healthUrl?: string;
  cause?: ErrorDiagnostic;
};

function readErrorString(error: Error, key: 'operation' | 'serviceUrl' | 'healthUrl'): string | undefined {
  if (!(key in error)) {
    return undefined;
  }
  const value = Reflect.get(error, key);
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function serializeErrorDiagnostic(error: Error): ErrorDiagnostic {
  const name = error.name || 'Error';
  const message = error.message || String(error);
  const diagnostic: ErrorDiagnostic = { name, message };
  if (error.stack) {
    diagnostic.stack = error.stack;
  }
  const operation = readErrorString(error, 'operation');
  const serviceUrl = readErrorString(error, 'serviceUrl');
  const healthUrl = readErrorString(error, 'healthUrl');
  if (operation) diagnostic.operation = operation;
  if (serviceUrl) diagnostic.serviceUrl = serviceUrl;
  if (healthUrl) diagnostic.healthUrl = healthUrl;
  if (error.cause instanceof Error) {
    diagnostic.cause = serializeErrorDiagnostic(error.cause);
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
