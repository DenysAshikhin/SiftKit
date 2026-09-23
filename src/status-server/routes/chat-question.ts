import type { IncomingMessage, ServerResponse } from 'node:http';
import { ChatQuestionAnswerRequestSchema, ChatQuestionAnswerResponseSchema } from '@siftkit/contracts';
import { toError } from '../../lib/errors.js';
import type { JsonObject } from '../../lib/json-types.js';
import { parseJsonBody, readBody, sendBodyReadError, sendJson } from '../http-utils.js';
import type { RouteEndpoint, RouteMatch } from '../route-table.js';
import type { ServerContext } from '../server-types.js';

/** Delivers the user's answer to the question the session's active run is waiting on. */
export class ChatQuestionAnswerEndpoint implements RouteEndpoint {
  async handle(ctx: ServerContext, req: IncomingMessage, res: ServerResponse, match: RouteMatch): Promise<void> {
    const sessionId = decodeURIComponent(match.captures[0] ?? '');
    let body: JsonObject;
    try {
      body = parseJsonBody(await readBody(req));
    } catch (error) {
      sendBodyReadError(res, toError(error), { error: 'Expected valid JSON object.' });
      return;
    }
    const parsed = ChatQuestionAnswerRequestSchema.safeParse(body);
    if (!parsed.success) {
      sendJson(res, 400, { error: parsed.error.issues[0]?.message ?? 'Expected questionId and a reply.' });
      return;
    }
    const gate = ctx.chatSessionOperations.getActive(sessionId)?.questionGate;
    const result = gate ? gate.answer(parsed.data.questionId, parsed.data.reply) : 'not_pending';
    if (result === 'invalid_choice') {
      sendJson(res, 400, { error: 'The chosen option does not exist for this question.' });
      return;
    }
    if (result === 'not_pending') {
      sendJson(res, 409, { error: 'No matching question is waiting for an answer.' });
      return;
    }
    sendJson(res, 200, ChatQuestionAnswerResponseSchema.parse({ ok: true, answeredAtUtc: new Date().toISOString() }));
  }
}
