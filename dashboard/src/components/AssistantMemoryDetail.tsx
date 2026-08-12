import React from 'react';
import type {
  AssistantAssertionExplanation,
  AssistantDeletionPreview,
  AssistantEvidenceDto,
  AssistantNodeDetail,
  AssistantProjectionDto,
} from '../types.js';
import type { AssistantNeighborhood } from '../assistant-api.js';

export type AssistantMemorySelection =
  | { kind: 'node'; value: AssistantNodeDetail; neighborhood: AssistantNeighborhood }
  | { kind: 'assertion'; value: AssistantAssertionExplanation; evidence: AssistantEvidenceDto[] }
  | { kind: 'projection'; value: AssistantProjectionDto };

/**
 * Per-item pixel reveal (spec §6): pixels appear only after an explicit confirmation, live only
 * in an object URL, and the URL is revoked the moment the preview closes or unmounts.
 */
function EvidencePixelReveal(props: {
  evidence: AssistantEvidenceDto;
  onFetchEvidencePixels(id: string): Promise<Blob>;
}) {
  const [objectUrl, setObjectUrl] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => () => {
    if (objectUrl !== null) window.URL.revokeObjectURL(objectUrl);
  }, [objectUrl]);

  async function reveal(): Promise<void> {
    if (!window.confirm('Reveal the stored pixels for this evidence item?')) return;
    try {
      const blob = await props.onFetchEvidencePixels(props.evidence.id);
      setError(null);
      setObjectUrl(window.URL.createObjectURL(blob));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  // The unmount/replace cleanup above is the only revoker, so a URL is revoked exactly once.
  function hide(): void {
    setObjectUrl(null);
  }

  if (objectUrl !== null) {
    return (
      <span className="assistant-evidence-reveal">
        <img src={objectUrl} alt={`Evidence ${props.evidence.id} pixels`} />
        <button type="button" className="ghost-btn" onClick={hide}>Hide pixels</button>
      </span>
    );
  }
  return (
    <span className="assistant-evidence-reveal">
      {error !== null ? <span className="error" role="alert">{error}</span> : null}
      <button type="button" className="ghost-btn" onClick={() => { void reveal(); }}>
        Reveal pixels
      </button>
    </span>
  );
}

export function AssistantMemoryDetail(props: {
  selected: AssistantMemorySelection | null;
  deletionPreview: AssistantDeletionPreview | null;
  onConfirm(id: string, reason: string): Promise<void>;
  onCorrect(id: string, objectText: string, reason: string): Promise<void>;
  onPin(id: string, pinned: boolean, reason: string): Promise<void>;
  onDemote(id: string, reason: string): Promise<void>;
  onPreviewForget(id: string): Promise<void>;
  onConfirmForget(id: string, previewToken: string): Promise<void>;
  onFetchEvidencePixels(id: string): Promise<Blob>;
}) {
  const [reason, setReason] = React.useState('User review in Memory Inspector');
  const [correction, setCorrection] = React.useState('');
  const selected = props.selected;
  if (selected === null) return <p className="hint">Select a memory result to inspect it.</p>;
  if (selected.kind === 'projection') {
    return (
      <article className="assistant-detail-card">
        <span className="bdg">Tier {selected.value.tier}</span>
        <h3>{selected.value.title}</h3>
        <p className="assistant-projection-content">{selected.value.content}</p>
        <p className="hint">Topic {selected.value.topicKey} · graph v{selected.value.graphVersion}</p>
      </article>
    );
  }
  if (selected.kind === 'node') {
    return (
      <article className="assistant-detail-card">
        <span className="bdg">{selected.value.type}</span>
        <h3>{selected.value.displayName}</h3>
        <p>{selected.value.description ?? 'Sensitive descriptive content is withheld.'}</p>
        <h4>Bounded neighborhood</h4>
        <p>{selected.neighborhood.nodeIds.length} nodes · {selected.neighborhood.assertionIds.length} assertions</p>
        {selected.neighborhood.truncatedBy.length > 0 ? (
          <p className="hint">Truncated by {selected.neighborhood.truncatedBy.join(', ')}</p>
        ) : null}
        <ul>{selected.neighborhood.nodeIds.map((id) => <li key={id}>{id}</li>)}</ul>
      </article>
    );
  }
  const assertion = selected.value.assertion;
  const deletionPreview = props.deletionPreview?.targetAssertionId === assertion.id
    ? props.deletionPreview
    : null;
  return (
    <article className="assistant-detail-card">
      <div className="assistant-card-heading">
        <h3>{assertion.predicate}: {assertion.objectText}</h3>
        <span className="bdg">{assertion.status}</span>
        <span className="bdg">{Math.round(assertion.confidence * 100)}%</span>
      </div>
      <p className="hint">Basis: {assertion.basis} · {assertion.sensitivity}</p>
      <label className="assistant-detail-field">
        <span>Reason</span>
        <input value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
      <label className="assistant-detail-field">
        <span>Correction</span>
        <input value={correction} onChange={(event) => setCorrection(event.target.value)} />
      </label>
      <div className="assistant-card-actions wrap">
        <button type="button" className="ghost-btn" onClick={() => { void props.onConfirm(assertion.id, reason); }}>Confirm</button>
        <button type="button" className="ghost-btn" disabled={!correction.trim()} onClick={() => { void props.onCorrect(assertion.id, correction, reason); }}>Correct</button>
        <button type="button" className="ghost-btn" onClick={() => { void props.onPin(assertion.id, !assertion.pinned, reason); }}>{assertion.pinned ? 'Unpin' : 'Pin'}</button>
        <button type="button" className="ghost-btn" onClick={() => { void props.onDemote(assertion.id, reason); }}>Demote</button>
        <button type="button" className="ghost-btn danger" onClick={() => { void props.onPreviewForget(assertion.id); }}>Preview forget</button>
      </div>
      <h4>Evidence metadata</h4>
      {selected.evidence.length === 0 ? <p className="hint">No linked evidence.</p> : null}
      {selected.evidence.map((evidence) => (
        <div className="assistant-evidence" key={evidence.id}>
          <strong>{evidence.sourceType}</strong> · {evidence.sourceRef ?? evidence.id}
          <span>{evidence.sensitivity} · content not loaded</span>
          {evidence.contentAvailable ? (
            <EvidencePixelReveal
              evidence={evidence}
              onFetchEvidencePixels={props.onFetchEvidencePixels}
            />
          ) : null}
        </div>
      ))}
      <p className="hint">Mutation IDs: {selected.value.mutationIds.join(', ') || 'none'}</p>
      {deletionPreview ? (
        <div className="assistant-delete-preview" role="alert">
          <strong>Forget preview</strong>
          <p>{deletionPreview.dependentAssertionIds.length} dependent assertions and {deletionPreview.affectedProjectionIds.length} projections are affected.</p>
          <button type="button" className="ghost-btn danger" onClick={() => { void props.onConfirmForget(assertion.id, deletionPreview.previewToken); }}>Confirm forget</button>
        </div>
      ) : null}
    </article>
  );
}
