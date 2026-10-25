import type { SecretScanner } from '../../assistant/domain/secrets.ts';
import type { StructuredRunFailureCode } from '../../assistant/inference/structured-runner.ts';
import type { JsonObject } from '../../lib/json-types.ts';

/** Audit details for unusable model output; the raw sample is kept only when it holds no secret. */
export function outputRejectionDetails(
  scanner: SecretScanner,
  failure: { readonly code: StructuredRunFailureCode; readonly attempts: number; readonly rawSample: string },
): JsonObject {
  const scan = scanner.scan(failure.rawSample);
  return {
    code: failure.code, attempts: failure.attempts,
    rawSample: scan.containsSecret ? null : failure.rawSample,
    ...(scan.containsSecret ? { rawSampleWithheld: [...scan.matchedRuleIds] } : {}),
  };
}
