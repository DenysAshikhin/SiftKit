import React from 'react';
import type { AssistantQuestionDto } from '../types.js';

export function AssistantQuestionCard(props: {
  question: AssistantQuestionDto | null;
  onAnswer(answer: string): Promise<void>;
  onSkip(): Promise<void>;
  onSnooze(eligibleAfterUtc: string): Promise<void>;
  onBlockTopic(): Promise<void>;
}) {
  const [answer, setAnswer] = React.useState('');
  const [snoozeUntil, setSnoozeUntil] = React.useState('');
  if (props.question === null) return <p className="hint">No question is pending.</p>;
  return (
    <article className="assistant-question-card">
      <span className="bdg">{props.question.questionType.replaceAll('_', ' ')}</span>
      <h3>{props.question.questionText}</h3>
      <textarea
        aria-label="Answer"
        rows={4}
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
      />
      <div className="assistant-card-actions">
        <button type="button" className="save" disabled={!answer.trim()} onClick={() => { void props.onAnswer(answer); }}>Answer</button>
        <button type="button" className="ghost-btn" onClick={() => { void props.onSkip(); }}>Skip</button>
        <button type="button" className="ghost-btn danger" onClick={() => { void props.onBlockTopic(); }}>Block topic</button>
      </div>
      <div className="assistant-snooze">
        <input
          aria-label="Snooze until"
          type="datetime-local"
          value={snoozeUntil}
          onChange={(event) => setSnoozeUntil(event.target.value)}
        />
        <button
          type="button"
          className="ghost-btn"
          disabled={!snoozeUntil}
          onClick={() => { void props.onSnooze(new Date(snoozeUntil).toISOString()); }}
        >
          Snooze
        </button>
      </div>
    </article>
  );
}
