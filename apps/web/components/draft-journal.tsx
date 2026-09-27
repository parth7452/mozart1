import {
  JournalInputError,
  MoneyError,
  cents,
  draftEntries,
  formatCents,
  projectedEntries,
  type DraftEntry,
  type ReasonFamily,
} from '@recouple/core-domain';

const STAGE_LABELS: Record<DraftEntry['stage'], string> = {
  found: 'Deduction found',
  recovered: 'Recovered',
  written_off: 'Written off',
};

function Entry({ entry }: { entry: DraftEntry }) {
  return (
    <table className="draft-journal-entry">
      <caption>{STAGE_LABELS[entry.stage]}</caption>
      <thead>
        <tr>
          <th>Account</th>
          <th>Debit</th>
          <th>Credit</th>
        </tr>
      </thead>
      <tbody>
        {entry.lines.map((line, i) => (
          <tr key={i}>
            <td>{line.account}</td>
            <td>{line.debit > 0 ? formatCents(line.debit) : ''}</td>
            <td>{line.credit > 0 ? formatCents(line.credit) : ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The journal entries a case implies, as drafts. A pure function of its
 * props: nothing is posted, and there is no action here.
 */
export function DraftJournal(props: {
  amountCents: number;
  outcome?: 'won' | 'partial' | 'lost' | undefined;
  recoveredCents?: number | undefined;
  declined: boolean;
  family?: ReasonFamily | undefined;
  printedReasonCode?: string | undefined;
}) {
  const outcome = props.declined ? 'declined' : props.outcome;
  let body;
  try {
    const amountCents = cents(props.amountCents);
    const recoveredCents =
      props.recoveredCents === undefined ? undefined : cents(props.recoveredCents);
    const entries = draftEntries({
      amountCents,
      recoveredCents,
      outcome,
      family: props.family,
      printedReasonCode: props.printedReasonCode,
    });
    const projected = outcome === undefined ? projectedEntries(amountCents, props.family) : undefined;
    body = (
      <>
        {entries.map((e) => (
          <Entry key={e.stage} entry={e} />
        ))}
        {projected === undefined ? null : (
          <>
            <h4>If won</h4>
            {projected.won
              .filter((e) => e.stage !== 'found')
              .map((e) => (
                <Entry key={e.stage} entry={e} />
              ))}
            <h4>If lost</h4>
            {projected.lost
              .filter((e) => e.stage !== 'found')
              .map((e) => (
                <Entry key={e.stage} entry={e} />
              ))}
            <p>A partial recovery splits between the two.</p>
          </>
        )}
      </>
    );
  } catch (e) {
    if (e instanceof JournalInputError || e instanceof RangeError || e instanceof MoneyError) {
      body = <p role="alert">Cannot draft entries: {e.message}</p>;
    } else {
      throw e;
    }
  }
  return (
    <section className="draft-journal" aria-label="Draft accounting entries">
      <h3>
        Draft accounting entries <span className="badge">Draft — not posted</span>
      </h3>
      <p>
        Nothing is posted to your books. Posting needs its own decision record. Accounts are
        suggested defaults.
      </p>
      {props.family === undefined ? (
        <p>The expense account is chosen once a reason is decided.</p>
      ) : null}
      {body}
    </section>
  );
}

