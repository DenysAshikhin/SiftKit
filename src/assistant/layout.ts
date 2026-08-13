import path from 'node:path';

/**
 * Everything the assistant writes outside the runtime database. The single definition of the
 * on-disk layout: a second construction site guessing these paths would generate a second
 * encryption key and orphan every existing evidence blob.
 */
function assistantRoot(runtimeRoot: string): string {
  return path.join(runtimeRoot, 'assistant');
}

/** Content-addressed AES-256-GCM evidence blob envelopes (design §5.4). */
export function assistantEvidenceDir(runtimeRoot: string): string {
  return path.join(assistantRoot(runtimeRoot), 'evidence');
}

/** The `0600` JSON file holding the evidence encryption key (design §4.7). */
export function assistantKeyFile(runtimeRoot: string): string {
  return path.join(assistantRoot(runtimeRoot), 'keys.json');
}

/** Where restore parks verified uploads between preview and confirm (§16.4). Swept on start. */
export function assistantRestoreUploadsDir(runtimeRoot: string): string {
  return path.join(assistantRoot(runtimeRoot), 'restore-uploads');
}
