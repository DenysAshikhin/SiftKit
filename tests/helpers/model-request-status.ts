import { ModelRequestQueueDiagnosticsSchema, type ModelRequestQueueDiagnostics } from '../../src/lib/operation-stream.ts';
import { requestJson } from './dashboard-http.ts';

/** Reads `/status` model request diagnostics through the published contract. */
export async function readStatusModelRequests(baseUrl: string): Promise<ModelRequestQueueDiagnostics> {
  const response = await requestJson(`${baseUrl}/status`);
  return ModelRequestQueueDiagnosticsSchema.parse(response.body.modelRequests);
}
