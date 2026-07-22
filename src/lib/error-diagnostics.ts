import { z } from './zod.js';

export const ErrorDiagnosticSchema = z.object({
  name: z.string(),
  message: z.string(),
  stack: z.string().optional(),
  operation: z.string().optional(),
  serviceUrl: z.string().optional(),
  healthUrl: z.string().optional(),
  get cause() {
    return ErrorDiagnosticSchema.optional();
  },
});
export type ErrorDiagnostic = z.infer<typeof ErrorDiagnosticSchema>;

export const ServerErrorPayloadSchema = z.object({
  error: z.string(),
  errorName: z.string(),
  diagnosticId: z.string(),
  diagnostic: ErrorDiagnosticSchema,
});
export type ServerErrorPayload = z.infer<typeof ServerErrorPayloadSchema>;

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
