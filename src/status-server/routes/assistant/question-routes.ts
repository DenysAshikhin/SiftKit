import { sendJson } from '../../http-utils.js';
import {
  AnswerSchema, assistantRoute, body, id, QUESTION_ANSWER_BODY_LIMIT, QuestionIdSchema,
  SnoozeSchema, success,
} from './helpers.js';

export const markShownEndpoint = assistantRoute(async ({ service, req, res }) => {
  const request = await body(req, QuestionIdSchema, QUESTION_ANSWER_BODY_LIMIT);
  service.markQuestionShown(request.questionId);
  sendJson(res, 200, success(service));
});

export const dismissEndpoint = assistantRoute(async ({ service, req, res }) => {
  const request = await body(req, QuestionIdSchema, QUESTION_ANSWER_BODY_LIMIT);
  service.dismissQuestion(request.questionId);
  sendJson(res, 200, success(service));
});

export const currentEndpoint = assistantRoute(({ service, res }) => {
  sendJson(res, 200, { question: service.currentQuestion() });
});

export const answerEndpoint = assistantRoute(async ({ service, req, res, match }) => {
  const request = await body(req, AnswerSchema, QUESTION_ANSWER_BODY_LIMIT);
  sendJson(res, 200, service.questionFeedback.answer({
    ownerId: service.ownerId, questionId: id(match), answer: request.answer,
  }));
});

export const skipEndpoint = assistantRoute(({ service, res, match }) => {
  service.questionFeedback.skip(service.ownerId, id(match));
  sendJson(res, 200, success(service));
});

export const snoozeEndpoint = assistantRoute(async ({ service, req, res, match }) => {
  const request = await body(req, SnoozeSchema);
  service.questionFeedback.snooze(service.ownerId, id(match), request.eligibleAfterUtc);
  sendJson(res, 200, success(service));
});

export const doNotRepeatEndpoint = assistantRoute(({ service, res, match }) => {
  service.questionFeedback.doNotRepeat(service.ownerId, id(match));
  sendJson(res, 200, success(service));
});

export const blockTopicEndpoint = assistantRoute(({ service, res, match }) => {
  service.questionFeedback.blockTopic(service.ownerId, id(match));
  sendJson(res, 200, success(service));
});
