export function isBackendReadyStatusCode(statusCode: number | undefined): boolean {
  return Number.isFinite(statusCode) && Number(statusCode) >= 200 && Number(statusCode) < 300;
}
