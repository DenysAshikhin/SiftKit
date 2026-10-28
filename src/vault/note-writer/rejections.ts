import type { SecretScanner } from '../../assistant/domain/secrets.ts';
import type { JsonObject } from '../../lib/json-types.ts';

/** Audit details for unusable model output; the raw sample is kept only when it holds no secret. */
export function outputRejectionDetails(scanner: SecretScanner, rawSample: string, extra: JsonObject): JsonObject {
  const scan = scanner.scan(rawSample);
  return {
    ...extra,
    rawSample: scan.containsSecret ? null : rawSample,
    ...(scan.containsSecret ? { rawSampleWithheld: [...scan.matchedRuleIds] } : {}),
  };
}
