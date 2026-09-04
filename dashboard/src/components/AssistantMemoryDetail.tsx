import React from 'react';
import type {
  AssistantAssertionExplanation,
  AssistantDeletionPreview,
  AssistantEvidenceDeletionPreview,
  AssistantEvidenceDto,
  AssistantNodeDetail,
  AssistantProjectionDto,
  AssistantTopicForgetPreview,
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
  evidenceDeletionPreview: AssistantEvidenceDeletionPreview | null;
  topicForgetPreview: AssistantTopicForgetPreview | null;
  onConfirm(id: string, reason: string): Promise<void>;
  onCorrect(id: string, objectText: string, reason: string): Promise<void>;
  onPin(id: string, pinned: boolean, reason: string): Promise<void>;
  onDemote(id: string, reason: string): Promise<void>;
  onPreviewForget(id: string): Promise<void>;
  onConfirmForget(id: string, previewToken: string): Promise<void>;
  onPreviewDeleteEvidence(id: string): Promise<void>;
  onConfirmDeleteEvidence(id: string, previewToken: string): Promise<void>;
  onPreviewForgetTopic(topicKey: string): Promise<void>;
  onConfirmForgetTopic(topicKey: string, previewToken: string, addPolicy: boolean): Promise<void>;
  onFetchEvidencePixels(id: string): Promise<Blob>;
  onClaimOwner(id: string, reason: string): Promise<void>;
}) {
  const [reason, setReason] = React.useState('User review in Memory Inspector');
  const [correction, setCorrection] = React.useState('');
  const [blockTopic, setBlockTopic] = React.useState(false);
  const selected = props.selected;

  /** Confirms before merging: it rewrites who a body of facts is about. */
  async function claimAsOwner(displayName: string, nodeId: string): Promise<void> {
    const confirmed = window.confirm(
      `Merge “${displayName}” into your own person node? Its facts and aliases move onto you.`,
    );
    if (!confirmed) return;
    await props.onClaimOwner(nodeId, reason);
  }

  if (selected === null) return <p className="hint">Select a memory result to inspect it.</p>;
  if (selected.kind === 'projection') {
    const projection = selected.value;
    const topicPreview = props.topicForgetPreview?.topicKey === projection.topicKey
      ? props.topicForgetPreview
      : null;
    return (
      <article className="assistant-detail-card">
        <span className="bdg">Tier {projection.tier}</span>
        <h3>{projection.title}</h3>
        <p className="assistant-projection-content">{projection.content}</p>
        <p className="hint">Topic {projection.topicKey} · graph v{projection.graphVersion}</p>
        <div className="assistant-card-actions wrap">
          <button
            type="button"
            className="ghost-btn danger"
            onClick={() => { void props.onPreviewForgetTopic(projection.topicKey); }}
          >
            Forget topic
          </button>
        </div>
        {topicPreview ? (
          <div className="assistant-delete-preview" role="alert">
            <strong>Forget topic preview</strong>
            <p>{topicPreview.assertionIds.length} assertions and {topicPreview.affectedProjectionIds.length} projections are affected.</p>
            <label className="settings-live-toggle-control">
              <input
                type="checkbox"
                aria-label="Also block this topic from being inferred again"
                checked={blockTopic}
                onChange={(event) => setBlockTopic(event.target.checked)}
              />
              Also block this topic from being inferred again
            </label>
            <button
              type="button"
              className="ghost-btn danger"
              onClick={() => {
                void props.onConfirmForgetTopic(
                  projection.topicKey, topicPreview.previewToken, blockTopic,
                );
              }}
            >
              Confirm forget topic
            </button>
          </div>
        ) : null}
      </article>
    );
  }
  if (selected.kind === 'node') {
    const node = selected.value;
    // Screenshot OCR reads the owner's name off a title bar several ways, and each spelling
    // becomes its own person whose facts no projection ever reads. Only the owner may say two
    // people are one: the merge service refuses the same request from the assistant.
    const claimable = node.type === 'person' && !node.isOwner && node.status === 'active';
    return (
      <article className="assistant-detail-card">
        <span className="bdg">{node.type}</span>
        {node.isOwner ? <span className="bdg">you</span> : null}
        <h3>{node.displayName}</h3>
        <p>{node.description ?? 'Sensitive descriptive content is withheld.'}</p>
        {node.aliases.length > 0 ? (
          <p className="hint">Also known as {node.aliases.join(', ')}</p>
        ) : null}
        {claimable ? (
          <>
            <label className="assistant-detail-field">
              <span>Reason</span>
              <input value={reason} onChange={(event) => setReason(event.target.value)} />
            </label>
            <div className="assistant-card-actions wrap">
              <button
                type="button"
                className="ghost-btn"
                onClick={() => { void claimAsOwner(node.displayName, node.id); }}
              >
                This is me
              </button>
            </div>
            <p className="hint">
              Moves every fact and alias on “{node.displayName}” onto your own node and marks this
              one merged. Reversible from the merge log.
            </p>
          </>
        ) : null}
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
  const evidencePreview = selected.evidence.some(
    (item) => item.id === props.evidenceDeletionPreview?.targetEvidenceId,
  ) ? props.evidenceDeletionPreview : null;
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
          <button
            type="button"
            className="ghost-btn danger"
            onClick={() => { void props.onPreviewDeleteEvidence(evidence.id); }}
          >
            Delete evidence
          </button>
        </div>
      ))}
      {evidencePreview ? (
        <div className="assistant-delete-preview" role="alert">
          <strong>Evidence deletion preview</strong>
          <p>{evidencePreview.dependentAssertionIds.length} dependent assertions and {evidencePreview.affectedProjectionIds.length} projections are affected.</p>
          <button
            type="button"
            className="ghost-btn danger"
            onClick={() => {
              void props.onConfirmDeleteEvidence(
                evidencePreview.targetEvidenceId, evidencePreview.previewToken,
              );
            }}
          >
            Confirm evidence deletion
          </button>
        </div>
      ) : null}
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
