/**
 * The two failure classes the assistant control surface distinguishes on the wire. The status
 * server maps them by type, so an error's HTTP status never depends on the wording of its message.
 */
export class AssistantNotFoundError extends Error {}

/** The request named a real thing whose current state forbids the operation. */
export class AssistantConflictError extends Error {}
