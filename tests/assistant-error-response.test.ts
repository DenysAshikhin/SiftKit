import test from 'node:test';
import assert from 'node:assert/strict';

import { AssistantConflictError, AssistantNotFoundError } from '../src/assistant/errors.ts';
import { z } from '../src/lib/zod.ts';
import { RequestBodyTooLargeError } from '../src/status-server/http-utils.ts';
import { assistantErrorResponse } from '../src/status-server/routes/assistant/helpers.ts';
import { VaultConflictError, VaultTitleTakenError, VaultValidationError } from '../src/vault/errors.ts';

function zodError(): z.ZodError {
  const result = z.object({ title: z.string() }).safeParse({});
  if (result.success) throw new Error('expected a parse failure');
  return result.error;
}

test('assistant errors map to wire status, code and recovery details by type', () => {
  assert.deepEqual(assistantErrorResponse(new AssistantNotFoundError('gone')), { status: 404, code: 'not_found', message: 'gone', details: {} });
  assert.deepEqual(assistantErrorResponse(new VaultConflictError('vnote_1', 3)), {
    status: 409, code: 'conflict', message: 'Vault note vnote_1 changed; current revision is 3.', details: { currentRevision: 3 },
  });
  assert.equal(assistantErrorResponse(new VaultTitleTakenError('Git')).code, 'title_taken');
  assert.equal(assistantErrorResponse(new AssistantConflictError('busy')).code, 'conflict');
  assert.deepEqual(
    [assistantErrorResponse(new RequestBodyTooLargeError(10)).status, assistantErrorResponse(new RequestBodyTooLargeError(10)).code],
    [413, 'body_too_large'],
  );
});

test('bad input is a 400 but a programming error is a 500', () => {
  assert.equal(assistantErrorResponse(zodError()).status, 400);
  assert.equal(assistantErrorResponse(new VaultValidationError('bad title')).status, 400);
  assert.equal(assistantErrorResponse(new Error('limit must be an integer.')).status, 400);
  const bug = new TypeError("Cannot read properties of undefined (reading 'prepare')");
  assert.deepEqual(assistantErrorResponse(bug), { status: 500, code: 'internal_error', message: bug.message, details: {} });
  assert.equal(assistantErrorResponse(new ReferenceError('x is not defined')).status, 500);
});
