import type { TabbyTokenEncodeResponse } from '../../src/llm-protocol/inference-client.ts';

/** TabbyAPI's `/v1/token/encode` answer for `tokenCount` tokens; every fake engine answers with it. */
export function tabbyTokenEncodeResponse(tokenCount: number): TabbyTokenEncodeResponse {
  return { tokens: Array.from({ length: tokenCount }, (_, index) => index + 1), length: tokenCount };
}
