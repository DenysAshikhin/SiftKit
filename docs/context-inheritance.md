# Chat context inheritance

Chat-launched work uses one conversation replay boundary. The operation keeps its own preset and system prompt; only the session conversation is inherited.

| Entry point | Conversation context supplied to the model | Result persistence |
| --- | --- | --- |
| Normal chat turn | Latest compaction summary plus messages after the compaction boundary | User and assistant messages remain in the session transcript |
| Chat-launched plan | Same `buildChatHistoryMessages` replay as chat | User prompt and plan result are appended to the transcript |
| Chat-launched repo-search | Same `buildChatHistoryMessages` replay as chat | User prompt and search result are appended to the transcript |
| Chat-launched repo-agent | Same `buildChatHistoryMessages` replay as chat | User prompt, approval audit rows, and final result are appended to the transcript |
| Standalone CLI/API run | No chat-session context | Run output is not written into a chat transcript |

`buildChatHistoryMessages` omits rows marked `compressedIntoSummary` from model context while the transcript UI continues to show those rows in its compacted-history fold. Each new compaction summarizes history that already includes the previous compaction summary, so the summaries form a chain rather than parallel context branches.

Persistence is one-way: chat-launched operation results and repo-agent approval decisions become later conversation history, but standalone runs do not gain or mutate session history.

The behavior is covered by:

- `tests/chat-repo-operation-runner.test.ts`: “chat repo operations inherit the chat conversation history without a system prompt”.
- `tests/repo-search-chat-execute.test.ts`: “repo-search task kind honors supplied history in the model call”.
- `tests/status-server-chat-repo-agent.test.ts`: “chat repo-agent approval holds the lease, resumes the stream, and persists an audit row”, including the assertion that a standalone repo-agent request has no history.
