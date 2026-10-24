/**
 * The two failure classes the assistant control surface distinguishes on the wire. The status
 * server maps them by type, so an error's HTTP status never depends on the wording of its message.
 */
export class AssistantNotFoundError extends Error {}

/** The request named a real thing whose current state forbids the operation. */
export class AssistantConflictError extends Error {
  /** Wire code; a more specific conflict names its own. */
  readonly code: string;
  /** Fields the client needs to recover, sent beside the code and message. */
  readonly details: Readonly<Record<string, number>>;

  constructor(message: string, options: { readonly code?: string; readonly details?: Readonly<Record<string, number>> } = {}) {
    super(message);
    this.code = options.code ?? 'conflict';
    this.details = options.details ?? {};
  }
}
