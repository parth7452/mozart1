import {
  REASON_FAMILIES,
  diffSettlementLines,
  formatCents,
  settlementTotals,
  type SettlementLine,
  type SettlementLineChange,
  type SettlementLineProblem,
  type SettlementLineProblemCode,
  type StoredSettlementLine,
} from '@recouple/core-domain';
import type { SettlementOutcome } from '@recouple/store-postgres';
import type { SettlementDefaults, SettlementEditor } from '../lib/settlement-editor';
import { SETTLE_PARAMS, centsAsText, lineField } from '../lib/settlement-fields';

/** The store's `SETTLEMENT_OUTCOMES`; a type-only import keeps pg out of the view. */
const OUTCOMES: readonly SettlementOutcome[] = ['won', 'partial', 'lost', 'declined'];

const OUTCOME_WORDS: Record<SettlementOutcome, string> = {
  won: 'Won — recovered in full',
  partial: 'Partial — part recovered, the rest written off',
  lost: 'Lost — written off',
  declined: 'Declined — never filed, written off',
};

/** One fixed sentence per refusal. Nothing here is text a request brought. */
const PROBLEM_WORDS: Record<SettlementLineProblemCode, string> = {
  too_few_lines: 'An entry needs at least two lines.',
  too_many_lines: 'An entry has at most twenty lines.',
  not_integer_cents: 'An amount could not be read as dollars and cents.',
  both_sides: 'A line has a debit or a credit, not both.',
  no_side: 'A line with an account needs a debit or a credit.',
  account_missing: 'A line with an amount needs an account.',
  account_unknown: 'That account is not in your QuickBooks chart of accounts.',
  account_inactive: 'That account is inactive in QuickBooks.',
  account_type_refused:
    'That account cannot be used here: a line may not be on a receivable, payable or bank account.',
  receivable_changed:
    'The Accounts Receivable line is fixed by the case and cannot be changed, added or removed.',
  memo_too_long: 'A memo is at most 500 characters.',
  memo_control_character: 'A memo is one line of plain text.',
  unbalanced: 'The entry does not balance: total debits must equal total credits.',
  moves_more_than_computed: 'The entry moves more money than this settlement does.',
};

function problemSentence(problem: SettlementLineProblem): string {
  const words = PROBLEM_WORDS[problem.code];
  return problem.lineNo === undefined ? words : `Line ${problem.lineNo}: ${words}`;
}

/**
 * The first step: how the case settled. A GET to the case's own page, so the
 * entry it implies can be drawn before anything is written. No memo is in it.
 */
function ChooseForm({
  deductionId,
  defaults,
  again,
  label,
}: {
  deductionId: string;
  defaults: SettlementDefaults;
  again: boolean;
  label: string;
}) {
  return (
    <form action={`/cases/${deductionId}#settlement`} method="get" className="settlement-choose">
      {again ? <input type="hidden" name={SETTLE_PARAMS.again} value="1" /> : null}
      <label htmlFor="settle-outcome">How it settled</label>
      <select id="settle-outcome" name={SETTLE_PARAMS.outcome} required defaultValue={defaults.outcome ?? ''}>
        <option value="" disabled>
          Choose…
        </option>
        {OUTCOMES.map((outcome) => (
          <option key={outcome} value={outcome}>
            {OUTCOME_WORDS[outcome]}
          </option>
        ))}
      </select>
      <label htmlFor="settle-recovered">Recovered</label>
      <input
        id="settle-recovered"
        name={SETTLE_PARAMS.recovered}
        inputMode="decimal"
        placeholder="0.00"
        defaultValue={
          defaults.recoveredCents === undefined || defaults.recoveredCents < 0
            ? ''
            : centsAsText(defaults.recoveredCents)
        }
      />
      <label htmlFor="settle-family">Reason family</label>
      <select id="settle-family" name={SETTLE_PARAMS.family} defaultValue={defaults.family ?? ''}>
        <option value="">unclassified</option>
        {REASON_FAMILIES.map((family) => (
          <option key={family} value={family}>
            {family.replace(/_/g, ' ')}
          </option>
        ))}
      </select>
      <label htmlFor="settle-invoice">QuickBooks invoice id</label>
      <input
        id="settle-invoice"
        name={SETTLE_PARAMS.invoice}
        required
        pattern="[0-9]{1,20}"
        defaultValue={defaults.invoiceId ?? ''}
      />
      <button type="submit">{label}</button>
    </form>
  );
}

/**
 * The prepare form for a settlement's journal lines (ADR 0068 §7). A pure
 * function of what the page read: the computed lines pre-filled, an account
 * `<select>` over the chart, debit and credit as text the route reads with
 * `parseMoneyToCents`, a memo per line, the totals as the server added them,
 * Reset, and Prepare. No script.
 */
export function SettlementEditorForm({
  deductionId,
  editor,
}: {
  deductionId: string;
  editor: SettlementEditor;
}) {
  const heading = (
    <h4 id="settlement">
      Settlement entry for QuickBooks{' '}
      <span className="badge">Not posted until a second person approves</span>
    </h4>
  );
  const supersedeNote = editor.supersedes ? (
    <p className="hint">
      A settlement is already prepared for this case. Preparing again replaces it: the earlier one
      stays on the record and can no longer be approved.
    </p>
  ) : null;

  if (editor.kind === 'choose' || editor.kind === 'refused_choice') {
    return (
      <div className="settlement-editor">
        {heading}
        {supersedeNote}
        {editor.kind === 'choose' && editor.invalid ? (
          <p role="alert">
            That could not be read: choose how it settled, give the recovered amount as dollars and
            cents, and the QuickBooks invoice id as digits.
          </p>
        ) : null}
        {editor.kind === 'refused_choice' ? (
          <p role="alert">
            The books cannot hold that: a won case recovers the whole amount, a lost or declined one
            recovers nothing, and a partial one recovers less than was deducted.
          </p>
        ) : null}
        <p className="hint">
          Say how the case settled to see the journal entry it implies. You can change the accounts,
          split a line and add a memo before you prepare it; a second person then approves exactly
          what you prepared.
        </p>
        <ChooseForm
          deductionId={deductionId}
          defaults={editor.defaults}
          again={editor.supersedes}
          label="Show the entry to edit"
        />
      </div>
    );
  }

  const choiceDefaults: SettlementDefaults = {
    outcome: editor.choice.outcome,
    recoveredCents: editor.choice.recoveredCents,
    family: editor.choice.family,
    invoiceId: editor.choice.invoiceId,
  };

  if (editor.kind === 'chart_unreadable') {
    return (
      <div className="settlement-editor">
        {heading}
        <p role="alert">
          {editor.reason === 'not_configured'
            ? 'This deployment cannot read QuickBooks, so the entry cannot be edited or prepared here.'
            : 'Your QuickBooks chart of accounts could not be read just now, so the entry cannot be edited or prepared. Nothing was changed. Try again in a minute; if it keeps happening, check the connection under Settings → QuickBooks.'}
        </p>
        <ChooseForm deductionId={deductionId} defaults={choiceDefaults} again={editor.supersedes} label="Try again" />
      </div>
    );
  }

  const { rows, totals } = editor;
  const blank = Array.from({ length: editor.blankRows }, (_, index) => rows.length + index + 1);
  const options = editor.accounts.map((account) => (
    <option key={account.externalId} value={account.externalId}>
      {account.name} ({account.accountType})
    </option>
  ));
  const selectable = new Set(editor.accounts.map((account) => account.externalId));

  return (
    <div className="settlement-editor">
      {heading}
      {supersedeNote}
      <p className="hint">
        {OUTCOME_WORDS[editor.choice.outcome]}, {formatCents(editor.choice.recoveredCents)} recovered,
        invoice <span className="mono">{editor.choice.invoiceId}</span>.{' '}
        {editor.echoed
          ? 'These are the lines you entered. Memos are not kept when a form comes back: type them again.'
          : 'These are the computed lines. Change an account, split a line across the empty rows, or add a memo.'}
      </p>
      {editor.problems.length > 0 ? (
        <ul role="alert" className="settlement-problems">
          {editor.problems.map((problem, index) => (
            <li key={index}>{problemSentence(problem)}</li>
          ))}
        </ul>
      ) : null}
      <form action={`/cases/${deductionId}/settle`} method="post">
        <input type="hidden" name="intent" value="prepare" />
        <input type="hidden" name="outcome" value={editor.choice.outcome} />
        <input type="hidden" name="recovered" value={centsAsText(editor.choice.recoveredCents)} />
        <input type="hidden" name="family" value={editor.choice.family ?? ''} />
        <input type="hidden" name="invoiceId" value={editor.choice.invoiceId} />
        <table className="settlement-lines">
          <thead>
            <tr>
              <th>#</th>
              <th>Account</th>
              <th className="money">Debit</th>
              <th className="money">Credit</th>
              <th>Memo</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.lineNo}>
                <td>{row.lineNo}</td>
                <td>
                  {row.locked ? (
                    <>
                      <input type="hidden" name={lineField(row.lineNo, 'account')} value={row.accountExternalId} />
                      {row.accountName ?? `Account ${row.accountExternalId}`}{' '}
                      <span className="hint">fixed by the case</span>
                    </>
                  ) : (
                    <select
                      name={lineField(row.lineNo, 'account')}
                      aria-label={`Account, line ${row.lineNo}`}
                      defaultValue={selectable.has(row.accountExternalId) ? row.accountExternalId : ''}
                    >
                      <option value="">Choose an account…</option>
                      {options}
                    </select>
                  )}
                </td>
                {(['debit', 'credit'] as const).map((side) => (
                  <td key={side} className="money">
                    {row.locked ? (
                      <>
                        <input type="hidden" name={lineField(row.lineNo, side)} value={row[side]} />
                        {row[side]}
                      </>
                    ) : (
                      <input
                        name={lineField(row.lineNo, side)}
                        aria-label={`${side === 'debit' ? 'Debit' : 'Credit'}, line ${row.lineNo}`}
                        inputMode="decimal"
                        size={10}
                        defaultValue={row[side]}
                      />
                    )}
                  </td>
                ))}
                <td>
                  <input
                    name={lineField(row.lineNo, 'memo')}
                    aria-label={`Memo, line ${row.lineNo}`}
                    maxLength={500}
                    size={28}
                  />
                </td>
              </tr>
            ))}
            {blank.map((lineNo) => (
              <tr key={lineNo}>
                <td>{lineNo}</td>
                <td>
                  <select name={lineField(lineNo, 'account')} aria-label={`Account, line ${lineNo}`} defaultValue="">
                    <option value="">Empty row</option>
                    {options}
                  </select>
                </td>
                <td className="money">
                  <input name={lineField(lineNo, 'debit')} aria-label={`Debit, line ${lineNo}`} inputMode="decimal" size={10} />
                </td>
                <td className="money">
                  <input name={lineField(lineNo, 'credit')} aria-label={`Credit, line ${lineNo}`} inputMode="decimal" size={10} />
                </td>
                <td>
                  <input name={lineField(lineNo, 'memo')} aria-label={`Memo, line ${lineNo}`} maxLength={500} size={28} />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td />
              <th scope="row">Totals as shown</th>
              <td className="money">{formatCents(totals.debitCents)}</td>
              <td className="money">{formatCents(totals.creditCents)}</td>
              <td>
                {totals.balanced ? (
                  'Balances'
                ) : (
                  <strong role="alert">
                    Does not balance: debits {formatCents(totals.debitCents)}, credits{' '}
                    {formatCents(totals.creditCents)}
                  </strong>
                )}
              </td>
            </tr>
          </tfoot>
        </table>
        <p className="hint">
          Totals are added when the page is drawn, not as you type. An entry that does not balance is
          not prepared: it comes back here with both totals stated. A memo is sent to QuickBooks as
          that line&apos;s description.
        </p>
        <button className="primary" type="submit">
          Prepare the settlement for approval
        </button>{' '}
        <a href={editor.resetPath}>Reset to computed</a>
      </form>
      <details>
        <summary>Change how it settled</summary>
        <ChooseForm deductionId={deductionId} defaults={choiceDefaults} again={editor.supersedes} label="Show the entry again" />
      </details>
    </div>
  );
}

const CHANGE_WORDS: Record<Exclude<SettlementLineChange, 'added' | 'removed'>, string> = {
  account: 'account',
  amount: 'amount',
  memo: 'memo',
};

/** "account on line 2, memo on line 2": what a decision's lines changed from the computed ones. */
export function settlementDifferences(
  stored: readonly SettlementLine[],
  computed: readonly SettlementLine[],
): readonly string[] {
  const out: string[] = [];
  for (const difference of diffSettlementLines(stored, computed)) {
    for (const change of difference.changes) {
      if (change === 'added') out.push(`line ${difference.lineNo} added`);
      else if (change === 'removed') out.push(`computed line ${difference.lineNo} left out`);
      else out.push(`${CHANGE_WORDS[change]} on line ${difference.lineNo}`);
    }
  }
  return out;
}

/**
 * The lines a settlement decision was prepared with, as the approver reads
 * them: each account by the name and type the chart reported, the amounts,
 * the memos a person typed (rendered as text), and what differs from the
 * computed entry.
 */
export function StoredSettlementLines({
  lines,
  computed,
}: {
  lines: readonly StoredSettlementLine[];
  computed: readonly SettlementLine[] | undefined;
}) {
  const totals = settlementTotals(lines);
  const differences = computed === undefined ? undefined : settlementDifferences(lines, computed);
  return (
    <div className="settlement-stored">
      <table className="settlement-lines">
        <thead>
          <tr>
            <th>#</th>
            <th>Account</th>
            <th className="money">Debit</th>
            <th className="money">Credit</th>
            <th>Memo</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.lineNo}>
              <td>{line.lineNo}</td>
              <td>
                {line.accountNameAsReported}{' '}
                <span className="hint">
                  {line.accountTypeAsReported}, QuickBooks account{' '}
                  <span className="mono">{line.accountExternalId}</span>
                </span>
              </td>
              <td className="money">{line.debitCents > 0 ? formatCents(line.debitCents) : ''}</td>
              <td className="money">{line.creditCents > 0 ? formatCents(line.creditCents) : ''}</td>
              <td>{line.memo ?? ''}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td />
            <th scope="row">Totals</th>
            <td className="money">{formatCents(totals.debitCents)}</td>
            <td className="money">{formatCents(totals.creditCents)}</td>
            <td />
          </tr>
        </tfoot>
      </table>
      {differences === undefined ? (
        <p className="hint">
          The computed entry could not be drawn to compare with, so read every line.
        </p>
      ) : differences.length === 0 ? (
        <p className="hint">These are the computed lines, unchanged.</p>
      ) : (
        <p className="settlement-edited">
          <strong>Edited:</strong> {differences.join(', ')}.
        </p>
      )}
    </div>
  );
}
