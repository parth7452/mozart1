import type { DuplicateCandidateCase, PossibleDuplicatePair } from '@recouple/pipeline';
import { money } from '../lib/format';

/**
 * The pairs identity resolution refused to merge, and the two things a person
 * can say about one.
 *
 * `resolveIdentity` merges on an exact identifier match and nothing else. When
 * the invoice, the amount and the date all agree but no identifier does, it
 * opens the second case anyway and records the pair — because a second case is
 * visible and a wrong merge is not (ADR 0025 §6). This is where that pair is
 * finally visible.
 *
 * Nothing here merges anything. A verdict is a record of what a person
 * concluded: "Same deduction" writes it down and takes the pair off this list,
 * and neither case moves, changes state or disappears (ADR 0032 §5). The
 * sentences say so, because a button labelled as if it merged would be a button
 * that lied about what it did on a money path.
 *
 * A pure function of what the store returned, like every other view here. Every
 * claim id, invoice number and retailer name on this page is text off somebody
 * else's document: React escapes it, and nothing here builds markup out of it
 * or puts it in a URL.
 */

/** Which page the answer was given on, so the reviewer is sent back to it. */
type Whence = 'list' | 'case';

/** What one of the two cases is, in the few facts that tell it from the other. */
function Side({ side, label }: { side: DuplicateCandidateCase; label: string }) {
  return (
    <div>
      <span className="ledger-tag">{label}</span>
      <p style={{ margin: '4px 0 0' }}>
        <a href={`/cases/${side.deductionId}`}>
          {side.claimId ?? side.deductionId.slice(0, 8)}
        </a>{' '}
        <span className={`pill state-${side.state}`}>{side.state.replace(/_/g, ' ')}</span>
      </p>
      <p className="hint" style={{ margin: '4px 0 0' }}>
        {money(side.deductionAmountCents)}
        {side.deductionDate === undefined ? null : ` · ${side.deductionDate}`}
      </p>
      <p className="hint" style={{ margin: 0 }}>
        {side.retailer ?? 'Retailer unknown'}
        {side.retailer !== undefined && !side.retailerMatched ? (
          <span className="unmatched">not matched to a debtor</span>
        ) : null}
      </p>
      {side.invoiceNumber === undefined ? null : (
        <p className="mono" style={{ margin: '2px 0 0' }}>
          invoice {side.invoiceNumber}
        </p>
      )}
    </div>
  );
}

/**
 * The two answers, as one form with two submit buttons.
 *
 * A POST, not a link: this writes to two money-bearing cases, and a thing that
 * writes is not something a crawler or a prefetch may do by visiting a URL. The
 * verdict travels as the button's own value, so a form that arrives without one
 * is answered rather than guessed at.
 *
 * The path names the case whose page the reviewer is on, and the other id
 * travels in the form — the store treats the pair symmetrically and the route
 * sends the reviewer back to where they were.
 */
function Answer({
  deductionId,
  otherDeductionId,
  from,
}: {
  deductionId: string;
  otherDeductionId: string;
  from: Whence;
}) {
  return (
    <form action={`/cases/${deductionId}/duplicate`} method="post">
      <input type="hidden" name="other" value={otherDeductionId} />
      <input type="hidden" name="from" value={from} />
      <button type="submit" name="verdict" value="same">
        Same deduction
      </button>{' '}
      <button type="submit" name="verdict" value="different">
        Different deductions
      </button>
    </form>
  );
}

/** What the matcher found agreed, in a person's words rather than a field path. */
const BASIS_LABELS: Readonly<Record<string, string>> = {
  invoice_number: 'the same invoice',
  amount_cents: 'the same amount',
  deduction_date: 'a deduction date within a week',
  debtor_id: 'the same debtor',
  claim_id: 'the same claim id',
};

export function basisSentence(basis: readonly string[]): string {
  const said = basis.map((fact) => BASIS_LABELS[fact] ?? fact.replace(/_/g, ' '));
  if (said.length === 0) return 'nothing this page can name';
  if (said.length === 1) return said[0] as string;
  return `${said.slice(0, -1).join(', ')} and ${said[said.length - 1] as string}`;
}

/**
 * Every unanswered pair this tenant has, on the case list.
 *
 * Shown only to a member who may write, because the only thing to do about a
 * pair is answer it — and a reader who cannot answer would be looking at a list
 * of things they are not allowed to resolve. The database refuses them anyway.
 */
export function PossibleDuplicates({ pairs }: { pairs: readonly PossibleDuplicatePair[] }) {
  if (pairs.length === 0) return null;

  return (
    <div className="card duplicates">
      <h2 className="section" style={{ marginTop: 0 }}>
        Possible duplicates
      </h2>
      <p className="empty">
        Two cases agreed on enough to be one deduction, and on no identifier at all — so both
        were opened and neither was merged. Nothing here merges them either: saying they are the
        same records that, and both cases stay exactly as they are.
      </p>
      <table className="cases">
        <thead>
          <tr>
            <th>Opened first</th>
            <th>Opened later</th>
            <th>What agreed</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {pairs.map((pair) => (
            <tr key={`${pair.older.deductionId}:${pair.newer.deductionId}`}>
              <td>
                <Side side={pair.older} label="HELD" />
              </td>
              <td>
                <Side side={pair.newer} label="ARRIVED" />
              </td>
              <td>{basisSentence(pair.basis)}</td>
              <td>
                <Answer
                  deductionId={pair.older.deductionId}
                  otherDeductionId={pair.newer.deductionId}
                  from="list"
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The same question, on the page of one of the two cases.
 *
 * A reviewer who opens a case that may be a duplicate of another should not
 * have to go back to the list to find that out — deciding what to do about a
 * deduction is exactly where knowing matters, and a packet assembled on one
 * half of a pair is work done twice at best.
 */
export function DuplicateNotice({
  deductionId,
  pairs,
  mayAct,
}: {
  deductionId: string;
  pairs: readonly PossibleDuplicatePair[];
  mayAct: boolean;
}) {
  if (pairs.length === 0) return null;

  return (
    <div className="card duplicates" style={{ marginTop: 18 }}>
      <h2 className="section" style={{ marginTop: 0 }}>
        This may already be a case
      </h2>
      <p className="hint">
        Nothing was merged: the identifiers did not match, so both cases were opened. Answering
        it records what you concluded — neither case changes state, and nothing is sent anywhere
        either way.
      </p>
      {pairs.map((pair) => {
        // The other one, whichever side of the pair this case is.
        const other = pair.older.deductionId === deductionId ? pair.newer : pair.older;
        return (
          <div key={other.deductionId} style={{ marginTop: 12 }}>
            <Side side={other} label="THE OTHER CASE" />
            <p className="hint" style={{ margin: '6px 0 0' }}>
              They agree on {basisSentence(pair.basis)}.
            </p>
            {mayAct ? (
              <Answer deductionId={deductionId} otherDeductionId={other.deductionId} from="case" />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
