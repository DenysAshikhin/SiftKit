const DEFAULT_MAX_STORED_CHARACTERS = 2_000_000;
const REQUEST_BODY_OMITTED_LINE = 'srv  log_server_r: request: [request body omitted from managed llama log storage]\n';
const ECHO_OMITTED_LINE = '[managed llama verbose echo omitted from managed llama log storage]\n';

function isManagedLlamaEchoLine(line: string): boolean {
  return String(line || '').includes('update_chat_: Parsing chat message:');
}

function isManagedLlamaRequestEchoStart(line: string): boolean {
  return String(line || '').includes('log_server_r: request:');
}

function isManagedLlamaStructuredLogLine(line: string): boolean {
  return /^(?:srv|slot|que|res)\s{2,}|^(?:main|init|start|build_info|system_info|load_|create_tensor|llama_|ggml_|print_info|common_|set_|adapters_|CUDA Graph|Parsed message:)/u.test(String(line || ''));
}

function splitChunkPreservingLines(chunk: string): string[] {
  return String(chunk || '').match(/[^\n]*\n|[^\n]+/gu) ?? [];
}

export type ManagedLlamaLogStorageFilterOptions = {
  maxStoredCharacters?: number;
};

export class ManagedLlamaLogStorageFilter {
  private readonly maxStoredCharacters: number;
  private storedCharacters = 0;
  private omittedRequestEcho = false;
  private truncated = false;

  constructor(options: ManagedLlamaLogStorageFilterOptions = {}) {
    this.maxStoredCharacters = Number.isFinite(options.maxStoredCharacters) && Number(options.maxStoredCharacters) > 0
      ? Math.trunc(Number(options.maxStoredCharacters))
      : DEFAULT_MAX_STORED_CHARACTERS;
  }

  filterChunk(chunk: string): string {
    const parts: string[] = [];
    for (const segment of splitChunkPreservingLines(chunk)) {
      const line = segment.replace(/\r?\n$/u, '');
      if (this.omittedRequestEcho) {
        if (!isManagedLlamaStructuredLogLine(line) || isManagedLlamaRequestEchoStart(line)) {
          continue;
        }
        this.omittedRequestEcho = false;
      }
      if (isManagedLlamaRequestEchoStart(line)) {
        this.omittedRequestEcho = true;
        parts.push(REQUEST_BODY_OMITTED_LINE);
        continue;
      }
      if (isManagedLlamaEchoLine(line)) {
        parts.push(ECHO_OMITTED_LINE);
        continue;
      }
      parts.push(segment);
    }
    return this.applyStoredCharacterLimit(parts.join(''));
  }

  private applyStoredCharacterLimit(chunk: string): string {
    if (!chunk || this.truncated) {
      return '';
    }
    const remaining = this.maxStoredCharacters - this.storedCharacters;
    if (remaining <= 0) {
      this.truncated = true;
      return '[managed llama log truncated after storage limit]\n';
    }
    if (chunk.length <= remaining) {
      this.storedCharacters += chunk.length;
      return chunk;
    }
    this.storedCharacters = this.maxStoredCharacters;
    this.truncated = true;
    return `${chunk.slice(0, remaining)}\n[managed llama log truncated after storage limit]\n`;
  }
}
