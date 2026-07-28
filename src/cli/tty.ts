/** Approval prompting needs a real terminal; fail before touching the network. */
export function assertStdinIsTty(
  required: boolean,
  stdin: { isTTY?: boolean } | undefined,
  context: string,
): void {
  if (required && stdin?.isTTY !== true) {
    throw new Error(`${context} requires a TTY (stdin is not interactive).`);
  }
}
