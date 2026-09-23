import type {
  CaseMerges,
  DuplicateCandidateCase,
  MergeRefusal,
  PossibleDuplicatePair,
} from '@recouple/pipeline';
import { money } from '../lib/format';

/**
 * The pairs identity resolution refused to merge, the two things a person can
 * say about one, and what a merge looks like afterwards.
 *
 * `resolveIdentity` merges on an exact identifier match and nothing else. When
 * the invoice, the amount and the date all agree but no identifier does, it
 * opens the second case anyway and records the pair — because a second case is
 * visible and a wrong merge is not (ADR 0025 §6). This is where that pair is
 * finally visible.
 *
 * "Same deduction" records the verdict and merges the two when the database
 * allows it (ADR 0042): the copy is marked as merged into the case that carries
 * on, keeps its whole timeline, and can be put back from its own page. Nothing
 * is deleted. When the database refuses — two filings, amounts a cent apart —
 * the verdict stands and the page says why. Every sentence says which of those
 * happened, because a button that claimed a merge it did not do, or hid one it
 * did, would be lying on a money path.
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
        Same deduction — merge them
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
        were opened and neither was merged. Saying they are the same merges them: the one somebody
        worked on, else the older one, carries on, and the other is marked as merged into it,
        keeps its timeline and can be put back.
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
        The identifiers did not match, so both cases were opened. Saying they are the same merges
        them — the copy is marked as merged, keeps its timeline and can be put back. Nothing is
        sent anywhere either way.
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

/**
 * Why a confirmed pair was not merged, in a reviewer's words (ADR 0042). One
 * sentence per reason the database can give, typed so a new reason is a
 * compile error here rather than a blank on a case page.
 */
export const MERGE_REFUSAL_SENTENCES: Readonly<Record<MergeRefusal, string>> = {
  not_visible: 'the other case is not one this workspace can see.',
  not_confirmed: 'nobody has said these two are the same deduction.',
  already_merged: 'one of the two is already merged into another case.',
  merged_before:
    'these two were merged once and the merge was undone. A pair is merged at most once, so both stay open.',
  absorbs_another:
    'the case that would be merged away has itself absorbed another case — undo that merge first.',
  both_filed:
    'both were filed with the retailer, so two disputes are open there. Withdraw one with the retailer; nothing here can.',
  amounts_disagree:
    'the amounts differ, so they may be two deductions against the same invoice. Merging would lose one.',
  not_mergeable_state: 'the case that would be merged away has already been filed.',
  not_merged: 'this case is not merged into another.',
  stale: 'one of the two changed while this was being decided — reload and try again.',
};

/**
 * What a case page says about merges: that this case was merged into another,
 * the cases merged into it, and the confirmed pairs that are not merged.
 *
 * A pure function of `mergesFor`. Claim ids are text off somebody else's
 * document and are rendered as text; ids go into links and form fields only as
 * the store returned them.
 */
export function CaseMergeNotes({
  deductionId,
  merges,
  mayAct,
}: {
  deductionId: string;
  merges: CaseMerges | undefined;
  mayAct: boolean;
}) {
  if (merges === undefined) return null;
  const { mergedInto, absorbed, confirmedNotMerged } = merges;
  if (mergedInto === undefined && absorbed.length === 0 && confirmedNotMerged.length === 0) {
    return null;
  }

  return (
    <>
      {mergedInto === undefined ? null : (
        <div className="card duplicates merged" style={{ marginTop: 18 }}>
          <h2 className="section" style={{ marginTop: 0 }}>
            Merged into another case
          </h2>
          <p>
            This is the same deduction as{' '}
            <a href={`/cases/${mergedInto.deductionId}`}>
              {mergedInto.claimId ?? mergedInto.deductionId.slice(0, 8)}
            </a>{' '}
            ({money(mergedInto.deductionAmountCents)}), which carries on. Merged{' '}
            {mergedInto.mergedAt.slice(0, 10)}.
          </p>
          <p className="hint">
            Its documents and timeline stay here, and it is not counted in coverage or matched
            against new arrivals. Nothing more can be recorded on it — work the case it was merged
            into.
          </p>
          {mayAct ? (
            <form action={`/cases/${deductionId}/unmerge`} method="post">
              <button type="submit">Undo the merge</button>{' '}
              <span className="hint">
                Puts this case back where it was and reopens the question. A pair can be merged
                only once.
              </span>
            </form>
          ) : null}
        </div>
      )}

      {absorbed.length === 0 ? null : (
        <div className="card duplicates" style={{ marginTop: 18 }}>
          <h2 className="section" style={{ marginTop: 0 }}>
            Merged into this case
          </h2>
          <p className="hint">
            Each of these is the same deduction as this one. Their documents stay on their own
            pages — attach one here as evidence if this case&apos;s packet should carry it.
          </p>
          <ul>
            {absorbed.map((copy) => (
              <li key={copy.mergeId}>
                <a href={`/cases/${copy.deductionId}`}>
                  {copy.claimId ?? copy.deductionId.slice(0, 8)}
                </a>{' '}
                · {money(copy.deductionAmountCents)} · merged {copy.mergedAt.slice(0, 10)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {confirmedNotMerged.length === 0 ? null : (
        <div className="card duplicates" style={{ marginTop: 18 }}>
          <h2 className="section" style={{ marginTop: 0 }}>
            The same deduction, not merged
          </h2>
          {confirmedNotMerged.map((other) => (
            <div key={other.deductionId} style={{ marginTop: 12 }}>
              <p style={{ margin: 0 }}>
                Somebody said this is the same deduction as{' '}
                <a href={`/cases/${other.deductionId}`}>
                  {other.claimId ?? other.deductionId.slice(0, 8)}
                </a>{' '}
                ({money(other.deductionAmountCents)}).{' '}
                {other.refusal === undefined
                  ? 'They can be merged now.'
                  : `They were not merged: ${MERGE_REFUSAL_SENTENCES[other.refusal]}`}
              </p>
              {mayAct && other.refusal === undefined ? (
                <form action={`/cases/${deductionId}/merge`} method="post">
                  <input type="hidden" name="other" value={other.deductionId} />
                  <button type="submit">Merge them</button>
                </form>
              ) : null}
            </div>
          ))}
          <p className="hint">
            Until they are merged, coverage counts this deduction twice.
          </p>
        </div>
      )}
    </>
  );
}
