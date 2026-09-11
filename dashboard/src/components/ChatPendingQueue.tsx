import React from 'react';
import type { ChatMessageQueueState, ChatQueueEditableMessage, ChatQueueMessageResponse } from '@siftkit/contracts';
import { toError } from '../../../src/lib/errors.js';

export type ChatPendingQueueActions = {
  onForceQueue(): Promise<void>;
  onLoadQueueMessage(id: string): Promise<ChatQueueMessageResponse>;
  onEditQueueMessage(id: string, content: string, revision: number): Promise<void>;
  onRemoveQueueMessage(id: string): Promise<void>;
};

export function ChatPendingQueue({ queue, ...actions }: ChatPendingQueueActions & { queue: ChatMessageQueueState | null }) {
  const [editing, setEditing] = React.useState<ChatQueueEditableMessage | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const pending = queue?.messages.filter((message) => message.state === 'pending') ?? [];
  const forcing = queue?.force?.phase === 'stopping' || queue?.force?.phase === 'sending';
  if (pending.length === 0 && !queue?.force && !error) return null;

  async function edit(id: string): Promise<void> {
    setBusy(true);
    try { setEditing((await actions.onLoadQueueMessage(id)).message); setError(null); }
    catch (cause) { setError(toError(cause).message); }
    finally { setBusy(false); }
  }
  async function save(): Promise<void> {
    if (!editing) return;
    setBusy(true);
    try { await actions.onEditQueueMessage(editing.id, editing.content, editing.revision); setEditing(null); setError(null); }
    catch (cause) { setError(toError(cause).message); }
    finally { setBusy(false); }
  }
  async function remove(id: string): Promise<void> {
    setBusy(true);
    try { await actions.onRemoveQueueMessage(id); if (editing?.id === id) setEditing(null); setError(null); }
    catch (cause) { setError(toError(cause).message); }
    finally { setBusy(false); }
  }
  return <section className="chat-pending-queue" aria-label="Pending messages">
    <div className="row">
      <strong>Pending messages ({pending.length})</strong>
      {pending.length > 0 || forcing ? <button type="button" className="mini-btn" disabled={busy || forcing} onClick={() => { void actions.onForceQueue(); }}>
        {queue?.force?.phase === 'stopping' ? 'Stopping…' : queue?.force?.phase === 'sending' ? 'Sending…' : 'Force now'}
      </button> : null}
    </div>
    {queue?.paused ? <p className="hint">Queue paused. Use Force now to continue.</p> : null}
    {queue?.force?.failureDetail ? <p role="alert">{queue.force.failureDetail}</p> : null}
    <ol>{pending.map((message, index) => {
      const frozen = forcing && queue?.force?.messageIds.includes(message.id);
      return <li key={message.id}>
        <span>{index + 1}. {message.preview}{message.contentChars > message.preview.length ? '…' : ''}</span>
        {message.imageCount > 0 ? <span> ({message.imageCount} images)</span> : null}
        <button type="button" className="mini-btn" disabled={busy || frozen} onClick={() => { void edit(message.id); }}>Edit</button>
        <button type="button" className="mini-btn" disabled={busy || frozen} onClick={() => { void remove(message.id); }}>Remove</button>
      </li>;
    })}</ol>
    {editing ? <div>
      <textarea aria-label="Edit queued message" value={editing.content} onChange={(event) => setEditing({ ...editing, content: event.target.value })} />
      <button type="button" disabled={busy || !editing.content.trim()} onClick={() => { void save(); }}>Save</button>
      <button type="button" disabled={busy} onClick={() => setEditing(null)}>Cancel</button>
    </div> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
