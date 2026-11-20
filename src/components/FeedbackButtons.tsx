// Useful / Not useful under each AI idea (Amendment 5 Phase 2). Live mode only.
// Optimistic: the pressed state changes at once and reverts if the server refuses.
import { useState } from 'preact/hooks';
import { COPY } from '../content/copy.js';

export type Vote = 'up' | 'down' | null;

/** What a vote call came back with. 'expired' shows the session text (App shows it once). */
export type VoteOutcome = 'ok' | 'expired' | 'error';

export type VoteHandler = (ideaIndex: number, vote: Vote) => Promise<VoteOutcome>;

/** Pressing the active button again clears the vote. */
export const nextVote = (current: Vote, pressed: 'up' | 'down'): Vote => (current === pressed ? null : pressed);

const F = COPY.feedback;

export const FeedbackButtons = ({ index, onVote, initialVote = null }: { index: number; onVote: VoteHandler; initialVote?: Vote }) => {
  const [vote, setVote] = useState<Vote>(initialVote);
  const [note, setNote] = useState<string | null>(null);

  const press = async (pressed: 'up' | 'down') => {
    const before = vote;
    const next = nextVote(before, pressed);
    setVote(next);
    setNote(next ? F.thanks : null);
    const outcome = await onVote(index, next);
    if (outcome === 'ok') return;
    setVote(before);
    setNote(outcome === 'expired' ? COPY.actions.sessionExpired : null);
  };

  return (
    <div class="oa-feedback" role="group" aria-label={F.question}>
      <span class="oa-feedback__question">{F.question}</span>
      <button type="button" class="oa-feedback__button" aria-pressed={vote === 'up'} onClick={() => void press('up')}>
        {F.up}
      </button>
      <button type="button" class="oa-feedback__button" aria-pressed={vote === 'down'} onClick={() => void press('down')}>
        {F.down}
      </button>
      <span class="oa-feedback__note" role="status">
        {note}
      </span>
    </div>
  );
};
