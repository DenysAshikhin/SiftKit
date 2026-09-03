import React from 'react';
import type {
  AssistantDeletionPreview,
  AssistantEvidenceDeletionPreview,
  AssistantProjectionDto,
  AssistantTopicForgetPreview,
} from '../types.js';
import type { AssistantMemorySelection } from '../components/AssistantMemoryDetail.js';
import type { AssistantTabProps } from '../tabs/AssistantTab.js';
import {
  answerAssistantQuestion,
  blockAssistantQuestionTopic,
  bootstrapAssistantToken,
  confirmAssistantAssertion,
  confirmDeleteAssistantEvidence,
  confirmForgetAssistantAssertion,
  confirmForgetAssistantTopic,
  correctAssistantAssertion,
  deleteAssistantPolicy,
  demoteAssistantAssertion,
  explainAssistantAssertion,
  fetchAssistantEvidencePixels,
  getAssistantEvidence,
  getAssistantNeighborhood,
  claimAssistantNodeAsOwner,
  getAssistantNode,
  getAssistantPolicies,
  getAssistantStatus,
  getCurrentAssistantQuestion,
  pinAssistantAssertion,
  previewDeleteAssistantEvidence,
  previewForgetAssistantAssertion,
  previewForgetAssistantTopic,
  searchAssistantMemory,
  setAssistantPolicyEnabled,
  skipAssistantQuestion,
  snoozeAssistantQuestion,
} from '../assistant-api.js';

export function useAssistantController(): { tabProps: AssistantTabProps } {
  const [token, setToken] = React.useState<string | null>(null);
  const [available, setAvailable] = React.useState(false);
  const [enabled, setEnabled] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState<AssistantTabProps['results']>(null);
  const [selected, setSelected] = React.useState<AssistantMemorySelection | null>(null);
  const [question, setQuestion] = React.useState<AssistantTabProps['question']>(null);
  const [policies, setPolicies] = React.useState<AssistantTabProps['policies']>([]);
  const [deletionPreview, setDeletionPreview] = React.useState<AssistantDeletionPreview | null>(null);
  const [evidenceDeletionPreview, setEvidenceDeletionPreview] =
    React.useState<AssistantEvidenceDeletionPreview | null>(null);
  const [topicForgetPreview, setTopicForgetPreview] =
    React.useState<AssistantTopicForgetPreview | null>(null);

  /** A preview is bound to one graph version and one target; changing either must void all. */
  function clearPreviews(): void {
    setDeletionPreview(null);
    setEvidenceDeletionPreview(null);
    setTopicForgetPreview(null);
  }

  React.useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const nextToken = await bootstrapAssistantToken();
        const [status, nextQuestion, nextPolicies] = await Promise.all([
          getAssistantStatus(nextToken),
          getCurrentAssistantQuestion(nextToken),
          getAssistantPolicies(nextToken),
        ]);
        if (!active) return;
        setToken(nextToken);
        setAvailable(status.available);
        setEnabled(status.enabled);
        setQuestion(nextQuestion);
        setPolicies(nextPolicies);
      } catch (caught) {
        if (active) {
          setError(caught instanceof Error ? caught.message : 'Assistant request failed.');
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  async function withToken(action: (value: string) => Promise<void>): Promise<void> {
    if (token === null) return;
    setError(null);
    try {
      await action(token);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Assistant request failed.');
    }
  }

  async function refreshAssertion(value: string, id: string): Promise<void> {
    const explanation = await explainAssistantAssertion(value, id);
    const evidence = await Promise.all(
      explanation.evidenceIds.map((evidenceId) => getAssistantEvidence(value, evidenceId)),
    );
    setSelected({ kind: 'assertion', value: explanation, evidence });
  }

  const tabProps: AssistantTabProps = {
    available,
    enabled,
    loading,
    error,
    query,
    results,
    selected,
    question,
    policies,
    deletionPreview,
    evidenceDeletionPreview,
    topicForgetPreview,
    onQueryChange: setQuery,
    onSearch: () => withToken(async (value) => { setResults(await searchAssistantMemory(value, query)); }),
    onSelectNode: (id) => withToken(async (value) => {
      const [node, neighborhood] = await Promise.all([
        getAssistantNode(value, id), getAssistantNeighborhood(value, id),
      ]);
      setSelected({ kind: 'node', value: node, neighborhood });
      clearPreviews();
    }),
    onSelectAssertion: (id) => withToken(async (value) => {
      await refreshAssertion(value, id);
      clearPreviews();
    }),
    onSelectProjection(projection: AssistantProjectionDto) {
      setSelected({ kind: 'projection', value: projection });
      clearPreviews();
    },
    onConfirm: (id, reason) => withToken(async (value) => {
      await confirmAssistantAssertion(value, id, reason);
      await refreshAssertion(value, id);
    }),
    onCorrect: (id, objectText, reason) => withToken(async (value) => {
      await correctAssistantAssertion(value, id, objectText, reason);
      await refreshAssertion(value, id);
    }),
    onPin: (id, pinned, reason) => withToken(async (value) => {
      await pinAssistantAssertion(value, id, pinned, reason);
      await refreshAssertion(value, id);
    }),
    onDemote: (id, reason) => withToken(async (value) => {
      await demoteAssistantAssertion(value, id, reason);
      await refreshAssertion(value, id);
    }),
    onClaimOwner: (id, reason) => withToken(async (value) => {
      const result = await claimAssistantNodeAsOwner(value, id, reason);
      // The claimed node is now `merged`, so re-select the owner: leaving the merged node on
      // screen would show a card whose facts have all moved elsewhere.
      const [node, neighborhood] = await Promise.all([
        getAssistantNode(value, result.ownerNodeId),
        getAssistantNeighborhood(value, result.ownerNodeId),
      ]);
      setSelected({ kind: 'node', value: node, neighborhood });
      if (query.trim()) setResults(await searchAssistantMemory(value, query));
    }),
    onPreviewForget: (id) => withToken(async (value) => {
      setDeletionPreview(await previewForgetAssistantAssertion(value, id));
    }),
    onConfirmForget: (id, previewToken) => withToken(async (value) => {
      await confirmForgetAssistantAssertion(value, id, previewToken);
      clearPreviews();
      setSelected(null);
      if (query.trim()) setResults(await searchAssistantMemory(value, query));
    }),
    onPreviewDeleteEvidence: (id) => withToken(async (value) => {
      setEvidenceDeletionPreview(await previewDeleteAssistantEvidence(value, id));
    }),
    onConfirmDeleteEvidence: (id, previewToken) => withToken(async (value) => {
      await confirmDeleteAssistantEvidence(value, id, previewToken);
      clearPreviews();
      setSelected(null);
      if (query.trim()) setResults(await searchAssistantMemory(value, query));
    }),
    onPreviewForgetTopic: (topicKey) => withToken(async (value) => {
      setTopicForgetPreview(await previewForgetAssistantTopic(value, topicKey));
    }),
    onConfirmForgetTopic: (topicKey, previewToken, addPolicy) => withToken(async (value) => {
      await confirmForgetAssistantTopic(value, { topicKey, addPolicy, previewToken });
      clearPreviews();
      setSelected(null);
      if (query.trim()) setResults(await searchAssistantMemory(value, query));
    }),
    onFetchEvidencePixels: async (id) => {
      if (token === null) throw new Error('Assistant authorization is unavailable.');
      return fetchAssistantEvidencePixels(token, id);
    },
    onAnswerQuestion: (answer) => withToken(async (value) => {
      if (question === null) return;
      await answerAssistantQuestion(value, question.id, answer);
      setQuestion(await getCurrentAssistantQuestion(value));
    }),
    onSkipQuestion: () => withToken(async (value) => {
      if (question === null) return;
      await skipAssistantQuestion(value, question.id);
      setQuestion(await getCurrentAssistantQuestion(value));
    }),
    onSnoozeQuestion: (eligibleAfterUtc) => withToken(async (value) => {
      if (question === null) return;
      await snoozeAssistantQuestion(value, question.id, eligibleAfterUtc);
      setQuestion(await getCurrentAssistantQuestion(value));
    }),
    onBlockQuestionTopic: () => withToken(async (value) => {
      if (question === null) return;
      await blockAssistantQuestionTopic(value, question.id);
      const [nextQuestion, nextPolicies] = await Promise.all([
        getCurrentAssistantQuestion(value), getAssistantPolicies(value),
      ]);
      setQuestion(nextQuestion);
      setPolicies(nextPolicies);
    }),
    onSetPolicyEnabled: (id, policyEnabled) => withToken(async (value) => {
      await setAssistantPolicyEnabled(value, id, policyEnabled);
      setPolicies(await getAssistantPolicies(value));
    }),
    onDeletePolicy: (id) => withToken(async (value) => {
      await deleteAssistantPolicy(value, id);
      setPolicies(await getAssistantPolicies(value));
    }),
  };
  return { tabProps };
}
