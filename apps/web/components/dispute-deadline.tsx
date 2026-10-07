import { isClosed, type CaseState } from '@recouple/core-domain';
import type { DisputeWindowAnswer } from '@recouple/store-postgres';
import { windowBasis, windowSourceWords } from '../lib/dispute-window-words';
import {
  DEADLINE_BASIS_MAX_LENGTH,
  MAX_ENTERED_DEADLINE_DAYS,
  type DeadlineSetRecord,
} from '@recouple/pipeline';

/** `YYYY-MM-DD` in UTC, `days` from `today`. */
function isoDaysFrom(today: Date, days: number): string {
  const at =
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) + days * 86_400_000;
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * The dispute deadline a person enters, and where it came from (pilot E6).
 *
 * Two parts. Where a person entered the deadline, every reader is told so and
 * on what basis: the pill at the top of the page looks the same for a printed
 * deadline and an entered one, and a reviewer deciding whether a case is late
 * is owed the difference. Where the case has no deadline at all and is still
 * open, a writer is offered the form — a date and the basis it was read from.
 *
 * The form's bounds are the store's (`checkEnteredDeadline`), and the store is
 * the referee: `min` is yesterday in UTC for the reason that check gives, and
 * a browser that ignores both still meets the named refusal.
 *
 * A pure function of what the store returned.
 */
export function DisputeDeadline({
  deductionId,
  state,
  disputeDeadline,
  deadlineSet,
  mayAct,
  today,
  disputeWindow,
}: {
  readonly deductionId: string;
  readonly state: CaseState;
  /** The case's deadline, printed or entered. */
  readonly disputeDeadline: string | undefined;
  /** The `case.deadline_set` event, when a person entered it. */
  readonly deadlineSet: DeadlineSetRecord | undefined;
  readonly mayAct: boolean;
  readonly today: Date;
  /**
   * The payer's dispute window on the deduction date (ADR 0071). With no
   * deadline on the case, it is said and prefills the form; a person still
   * records it. Never written by this view.
   */
  readonly disputeWindow?: DisputeWindowAnswer | undefined;
}) {
  if (deadlineSet !== undefined) {
    return (
      <p className="hint" style={{ marginTop: 18 }}>
        The deadline {deadlineSet.deadline} was entered by a person, not printed on a document.
        Basis: &ldquo;{deadlineSet.basis}&rdquo;
      </p>
    );
  }
  if (disputeDeadline !== undefined || !mayAct || isClosed(state)) return null;
  const window = disputeWindow?.kind === 'window' ? disputeWindow : undefined;

  return (
    <div className="card act" style={{ marginTop: 18 }}>
      <h2 className="section" style={{ marginTop: 0 }}>
        No dispute deadline
      </h2>
      <p className="hint">
        Nothing this case came from printed one, so the review queue is ranking it by age. If you
        know the payer&rsquo;s window, enter the date it closes and where that comes from. It is
        recorded with your name, and it cannot be changed here once entered.
      </p>
      {window === undefined ? null : (
        <p className="hint payer-window">
          Payer window: {window.window.windowDays} days from the deduction date → {window.deadline} (
          {windowSourceWords(window.window)}, {window.window.confidence})
        </p>
      )}
      <form action={`/cases/${deductionId}/deadline`} method="post">
        <label htmlFor="dispute-deadline">The date the dispute window closes</label>
        <input
          id="dispute-deadline"
          name="deadline"
          type="date"
          required
          min={isoDaysFrom(today, -1)}
          max={isoDaysFrom(today, MAX_ENTERED_DEADLINE_DAYS)}
          {...(window === undefined ? {} : { defaultValue: window.deadline })}
        />

        <label htmlFor="deadline-basis">Based on</label>
        <input
          id="deadline-basis"
          name="basis"
          type="text"
          required
          maxLength={DEADLINE_BASIS_MAX_LENGTH}
          placeholder="Sysco vendor agreement: 60 days from deduction date"
          {...(window === undefined ? {} : { defaultValue: windowBasis(window.window) })}
        />

        <button className="primary" type="submit">
          Record the deadline
        </button>
      </form>
    </div>
  );
}
