// The sole sanctioned `unknown` boundary in the repo: a thrown/caught value is
// genuinely arbitrary at the JS language level, so `unknown` is its only honest
// type. Every caught value is normalized to `Error` here and only the concrete
// `Error` type flows beyond this module. eslint permits `unknown` for this file
// alone (see eslint.config.mjs); nowhere else may reintroduce it.
export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function getErrorMessage(error: unknown): string {
  return toError(error).message;
}
