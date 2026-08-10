import React from 'react';
import type {
  AssistantDeletionPreview,
  AssistantPolicyDto,
  AssistantProjectionDto,
  AssistantQuestionDto,
} from '../types.js';
import type { AssistantSearchResult } from '../assistant-api.js';
import {
  AssistantMemoryDetail,
  type AssistantMemorySelection,
} from '../components/AssistantMemoryDetail.js';
import { AssistantQuestionCard } from '../components/AssistantQuestionCard.js';

export type AssistantTabProps = {
  available: boolean;
  enabled: boolean;
  loading: boolean;
  error: string | null;
  query: string;
  results: AssistantSearchResult | null;
  selected: AssistantMemorySelection | null;
  question: AssistantQuestionDto | null;
  policies: AssistantPolicyDto[];
  deletionPreview: AssistantDeletionPreview | null;
  onQueryChange(value: string): void;
  onSearch(): Promise<void>;
  onSelectNode(id: string): Promise<void>;
  onSelectAssertion(id: string): Promise<void>;
  onSelectProjection(value: AssistantProjectionDto): void;
  onConfirm(id: string, reason: string): Promise<void>;
  onCorrect(id: string, objectText: string, reason: string): Promise<void>;
  onPin(id: string, pinned: boolean, reason: string): Promise<void>;
  onDemote(id: string, reason: string): Promise<void>;
  onPreviewForget(id: string): Promise<void>;
  onConfirmForget(id: string, previewToken: string): Promise<void>;
  onAnswerQuestion(answer: string): Promise<void>;
  onSkipQuestion(): Promise<void>;
  onSnoozeQuestion(eligibleAfterUtc: string): Promise<void>;
  onBlockQuestionTopic(): Promise<void>;
  onSetPolicyEnabled(id: string, enabled: boolean): Promise<void>;
  onDeletePolicy(id: string): Promise<void>;
};

export function AssistantTab(props: AssistantTabProps) {
  return (
    <div className="assistant-inspector">
      <section className="assistant-pane assistant-results-pane">
        <header>
          <h2>Memory Inspector</h2>
          <span className={`bdg ${props.enabled ? 'custom' : ''}`}>
            {props.loading ? 'connecting' : props.enabled ? 'enabled' : 'disabled'}
          </span>
        </header>
        {props.error ? <p className="error" role="alert">{props.error}</p> : null}
        {!props.available && !props.loading ? <p className="hint">Assistant service is unavailable.</p> : null}
        <form
          className="assistant-search"
          onSubmit={(event) => { event.preventDefault(); void props.onSearch(); }}
        >
          <input
            aria-label="Search memory"
            placeholder="Search memory"
            value={props.query}
            onChange={(event) => props.onQueryChange(event.target.value)}
          />
          <button type="submit" className="save" disabled={!props.enabled || !props.query.trim()}>Search</button>
        </form>
        {props.results === null ? <p className="hint">Search nodes, assertions, and projections.</p> : null}
        {props.results !== null
          && props.results.nodes.length + props.results.assertions.length + props.results.projections.length === 0
          ? <p className="hint">No memory matched this search.</p> : null}
        {props.results?.nodes.map((node) => (
          <button key={node.id} type="button" className="assistant-result" onClick={() => { void props.onSelectNode(node.id); }}>
            <span>{node.displayName}</span><small>node · {node.type}</small>
          </button>
        ))}
        {props.results?.assertions.map((assertion) => (
          <button key={assertion.id} type="button" className="assistant-result" onClick={() => { void props.onSelectAssertion(assertion.id); }}>
            <span>{assertion.predicate}: {assertion.objectText}</span><small>assertion · {assertion.status}</small>
          </button>
        ))}
        {props.results?.projections.map((projection) => (
          <button key={projection.id} type="button" className="assistant-result" onClick={() => props.onSelectProjection(projection)}>
            <span>{projection.title}</span><small>projection · tier {projection.tier}</small>
          </button>
        ))}
      </section>
      <section className="assistant-pane assistant-detail-pane" aria-label="Memory detail">
        <h2>Memory detail</h2>
        <AssistantMemoryDetail
          selected={props.selected}
          deletionPreview={props.deletionPreview}
          onConfirm={props.onConfirm}
          onCorrect={props.onCorrect}
          onPin={props.onPin}
          onDemote={props.onDemote}
          onPreviewForget={props.onPreviewForget}
          onConfirmForget={props.onConfirmForget}
        />
      </section>
      <aside className="assistant-pane assistant-context-pane">
        <h2>Pending question</h2>
        <AssistantQuestionCard
          question={props.question}
          onAnswer={props.onAnswerQuestion}
          onSkip={props.onSkipQuestion}
          onSnooze={props.onSnoozeQuestion}
          onBlockTopic={props.onBlockQuestionTopic}
        />
        <h2>Question policies</h2>
        {props.policies.length === 0 ? <p className="hint">No policies configured.</p> : null}
        {props.policies.map((policy) => (
          <div className="assistant-policy" key={policy.id}>
            <span>{policy.policyType}{policy.topicKey ? ` · ${policy.topicKey}` : ''}</span>
            <label className="settings-live-toggle-control">
              <input type="checkbox" checked={policy.active} onChange={(event) => { void props.onSetPolicyEnabled(policy.id, event.target.checked); }} />
              {policy.active ? 'On' : 'Off'}
            </label>
            <button type="button" className="ghost-btn danger" onClick={() => { void props.onDeletePolicy(policy.id); }}>Delete</button>
          </div>
        ))}
      </aside>
    </div>
  );
}
