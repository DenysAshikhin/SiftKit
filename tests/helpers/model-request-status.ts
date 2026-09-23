import { ModelRequestQueueDiagnosticsSchema, type ModelRequestQueueDiagnostics } from '../../src/lib/operation-stream.js';
import { requestJson } from './dashboard-http.js';

/** Reads `/status` model request diagnostics through the published contract. */
export async function readStatusModelRequests(baseUrl: string): Promise<ModelRequestQueueDiagnostics> {
  const response = await requestJson(`${baseUrl}/status`);
  return ModelRequestQueueDiagnosticsSchema.parse(response.body.modelRequests);
}
