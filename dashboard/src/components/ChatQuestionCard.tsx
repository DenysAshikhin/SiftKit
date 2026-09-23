import React from 'react';
import { CHAT_QUESTION_MAX_NOTE_CHARS, type ChatQuestionReply, type DurableChatQuestion } from '@siftkit/contracts';
import { useExpired } from '../hooks/useExpired';
import { formatDate } from '../lib/format';

/** The assistant's question: up to three choices, an optional discuss note, and Cancel (which stops the run). */
export function ChatQuestionCard({ question, onAnswer, onCancel }: {
  question: DurableChatQuestion;
  onAnswer(reply: ChatQuestionReply): void;
  onCancel(): void;
}) {
  const [note, setNote] = React.useState('');
  const expired = useExpired(question.expiresAtUtc);
  const disabled = expired || !question.actionable || question.outcome !== null;
  const trimmedNote = note.trim();
  return (
    <section className="approval-card question-card" aria-label="Question from the assistant">
      <div className="approval-card-head">Question</div>
      <p className="question-text">{question.question}</p>
      {question.choices.length > 0 ? (
        <div className="approval-actions question-choices">
          {question.choices.map((choice, choiceIndex) => (
            <button key={choiceIndex} type="button" className="send" disabled={disabled}
              onClick={() => onAnswer({ choiceIndex, note: trimmedNote })}>{choice}</button>
          ))}
        </div>
      ) : null}
      <textarea
        aria-label="Discuss"
        value={note}
        maxLength={CHAT_QUESTION_MAX_NOTE_CHARS}
        disabled={disabled}
        placeholder={question.choices.length > 0 ? 'Optional: add context, or answer in your own words…' : 'Your answer…'}
        onChange={(event) => setNote(event.target.value)}
      />
      <p>{expired ? 'Question expired. ' : 'Expires: '}<time dateTime={question.expiresAtUtc}>{formatDate(question.expiresAtUtc)}</time></p>
      <div className="approval-actions">
        <button type="button" className="send" disabled={disabled || !trimmedNote}
          onClick={() => onAnswer({ choiceIndex: null, note: trimmedNote })}>Reply</button>
        <button type="button" className="mini-btn approval-abort" disabled={disabled} onClick={onCancel}>Cancel</button>
      </div>
    </section>
  );
}
