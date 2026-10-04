import {
  CANONICAL_REASON_CODES,
  MAPPABLE_REASON_CODES,
  PAYER_CODE_CONFIDENCES,
  PAYER_CODE_MAX_LENGTH,
  PAYER_CODE_SOURCE_NOTE_MAX_LENGTH,
  PAYER_CODE_SOURCES,
  REASON_FAMILIES,
  REASON_WORDS,
  type PayerCodeSource,
} from '@recouple/core-domain';
import type {
  MappableDebtor,
  PayerCodeMapListed,
  PayerCodeMappingAnswer,
  UnmappedPayerCodes,
} from '@recouple/store-postgres';
import { UNMAPPED_CASES_LIMIT } from '@recouple/store-postgres';
import { money } from '../lib/format';
import {
  mapItHref,
  mappingWords,
  REASON_CODES_PATH,
  resolveReasonCodeNotice,
  type ReasonCodePrefill,
} from '../lib/reason-code-words';
import { WorkspaceShell } from './workspace-shell';
import type { Viewer } from './case-list';

/**
 * Reason-code reconciliation, as a person sees it (ADR 0066): what a payer's
 * printed code means in our taxonomy, per payer, as data the workspace
 * recorded with its source and confidence.
 *
 * Pure functions of what the store returned. A payer's code is text off a
 * document, shown as text and never as markup. A mapping is shown, never
 * applied: nothing here decides a case.
 */

const SOURCE_LABEL: Readonly<Record<PayerCodeSource, string>> = {
  payer_guide_url: "The payer's own guide",
  customer_confirmed: 'Confirmed by the customer',
  glimpse_guide: "Glimpse's published guide",
  operator: 'A Mozart operator',
};

/**
 * The case page's line under the payer's printed code: what it maps to, with
 * where the mapping came from, or that there is none yet.
 */
export function PayerCodeMappingLine({
  mapping,
  mayMap,
}: {
  mapping: PayerCodeMappingAnswer | undefined;
  /** An owner or approver: offered the link that adds a mapping. */
  mayMap: boolean;
}) {
  if (mapping === undefined || mapping.kind === 'no_code') return null;
  if (mapping.kind === 'mapped') {
    const words = mappingWords(mapping.map);
    return (
      <p className="payer-code-mapping">
        Payer code <span className="mono">{mapping.payerCode}</span> → {words.reason} ({words.provenance})
      </p>
    );
  }
  if (mapping.kind === 'no_debtor') {
    return (
      <p className="payer-code-mapping empty">
        Payer code <span className="mono">{mapping.payerCode}</span>: no mapping yet. This case is not
        matched to a payer, and a mapping belongs to one.
      </p>
    );
  }
  return (
    <p className="payer-code-mapping empty">
      Payer code <span className="mono">{mapping.payerCode}</span>: no mapping yet
      {mapping.mappable ? (
        mayMap ? (
          <>
            . <a href={mapItHref(mapping.debtorId, mapping.payerCode)}>Add one</a>
          </>
        ) : (
          <>
            . An owner or approver can add one under <a href={REASON_CODES_PATH}>Reason codes</a>.
          </>
        )
      ) : (
        '. It is too long to be a reason code, so it cannot be mapped.'
      )}
    </p>
  );
}

function ReasonOptions() {
  return (
    <>
      {REASON_FAMILIES.map((family) => (
        <optgroup key={family} label={family.replace(/_/g, ' ')}>
          {MAPPABLE_REASON_CODES.filter((code) => CANONICAL_REASON_CODES[code] === family).map((code) => (
            <option key={code} value={code}>
              {REASON_WORDS[code]}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}

export function ReasonCodesPage({
  viewer,
  current,
  debtors,
  unmapped,
  mayMap,
  prefill,
  today,
  notice,
}: {
  viewer: Viewer;
  /** Every debtor's mappings in force today. */
  current: readonly PayerCodeMapListed[];
  debtors: readonly MappableDebtor[];
  unmapped: UnmappedPayerCodes;
  /** An owner or approver: may add a mapping. */
  mayMap: boolean;
  /** What a "map it" link asked the form to start with. */
  prefill?: ReasonCodePrefill | undefined;
  /** `YYYY-MM-DD`: the day "in force" was asked for, and the form's default start. */
  today: string;
  /** A notice key, never a sentence. */
  notice?: string | undefined;
}) {
  const said = resolveReasonCodeNotice(notice);
  const byDebtor = new Map<string, { name: string; maps: PayerCodeMapListed[] }>();
  for (const map of current) {
    const group = byDebtor.get(map.debtorId) ?? { name: map.debtorName, maps: [] };
    group.maps.push(map);
    byDebtor.set(map.debtorId, group);
  }
  const prefillDebtor = debtors.find((d) => d.debtorId === prefill?.debtorId)?.debtorId;

  return (
    <WorkspaceShell viewer={viewer} section="reason-codes">
      <main id="workspace-main" className="workspace-main">
        <div className="page-heading">
          <div>
            <p className="eyebrow">SETTINGS</p>
            <h1>Reason codes</h1>
            <p className="page-description">
              What each payer&rsquo;s own reason code means, in the reasons a dispute is decided by. A
              mapping is this workspace&rsquo;s record, with where it came from and how sure it is. It
              sets the reason a case starts with; a person still chooses.
            </p>
          </div>
        </div>

        {said === undefined ? null : (
          <p className={said.tone === 'good' ? 'notice sent' : 'notice bad'}>{said.text}</p>
        )}

        <section className="card reason-codes" aria-label="Payer codes with no mapping">
          <h2>Payer codes with no mapping</h2>
          {unmapped.rows.length === 0 ? (
            <p className="empty">
              {unmapped.casesWithCode === 0
                ? 'No case prints a payer reason code yet.'
                : 'Every payer code on a case has a mapping.'}
            </p>
          ) : (
            <table className="cases">
              <thead>
                <tr>
                  <th scope="col">Payer</th>
                  <th scope="col">Code as printed</th>
                  <th scope="col">Cases</th>
                  <th scope="col">Amount</th>
                  <th scope="col">
                    <span className="sr-only">Map it</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {unmapped.rows.map((row) => (
                  <tr key={`${row.debtorId ?? `printed:${row.printedName ?? ''}`}:${row.payerCode}`}>
                    <td>
                      {row.debtorName ??
                        (row.printedName === undefined ? 'Payer unknown' : `${row.printedName} (not matched)`)}
                    </td>
                    <td className="mono">{row.payerCode}</td>
                    <td>{row.caseCount}</td>
                    <td>{money(row.totalCents)}</td>
                    <td>
                      {row.mappable && row.debtorId !== undefined ? (
                        mayMap ? (
                          <a href={mapItHref(row.debtorId, row.payerCode)}>Map it</a>
                        ) : null
                      ) : row.debtorId === undefined ? (
                        'Match the payer first'
                      ) : (
                        'Too long to map'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="empty">
            {unmapped.casesMapped} of {unmapped.casesWithCode} case{unmapped.casesWithCode === 1 ? '' : 's'}{' '}
            with a payer code {unmapped.casesMapped === 1 ? 'has' : 'have'} a mapping. A case is checked on
            the day its deduction was taken.
            {unmapped.truncated
              ? ` Only the newest ${UNMAPPED_CASES_LIMIT} cases were read; older ones are not in this list.`
              : ''}
          </p>
        </section>

        <section className="card reason-codes" aria-label="Mappings in force">
          <h2>Mappings in force today</h2>
          {byDebtor.size === 0 ? (
            <p className="empty">No mapping has been added yet.</p>
          ) : (
            [...byDebtor.entries()].map(([debtorId, group]) => (
              <div key={debtorId}>
                <h3>{group.name}</h3>
                <table className="cases">
                  <thead>
                    <tr>
                      <th scope="col">Code as printed</th>
                      <th scope="col">Means</th>
                      <th scope="col">From</th>
                      <th scope="col">Source</th>
                      <th scope="col">Confidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.maps.map((map) => (
                      <tr key={map.id}>
                        <td className="mono">{map.payerCode}</td>
                        <td>{REASON_WORDS[map.canonicalCode]}</td>
                        <td>
                          {map.effectiveFrom}
                          {map.effectiveTo === undefined ? '' : ` to ${map.effectiveTo}`}
                        </td>
                        <td>
                          {SOURCE_LABEL[map.source]}
                          {map.sourceNote === undefined ? '' : `: ${map.sourceNote}`}
                        </td>
                        <td>{map.confidence}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))
          )}
        </section>

        {mayMap ? (
          <section id="add-mapping" className="card reason-codes" aria-label="Add a mapping">
            <h2>Add a mapping</h2>
            {debtors.length === 0 ? (
              <p className="empty">
                This workspace has no payers yet. A mapping belongs to a payer, so add the payer first.
              </p>
            ) : (
              <form action={`${REASON_CODES_PATH}/add`} method="post">
                <label htmlFor="codes-debtor">Payer</label>
                <select id="codes-debtor" name="debtorId" required defaultValue={prefillDebtor ?? ''}>
                  <option value="" disabled>
                    Choose a payer…
                  </option>
                  {debtors.map((debtor) => (
                    <option key={debtor.debtorId} value={debtor.debtorId}>
                      {debtor.displayName}
                    </option>
                  ))}
                </select>

                <label htmlFor="codes-code">Code as the payer prints it</label>
                <input
                  id="codes-code"
                  name="payerCode"
                  type="text"
                  required
                  maxLength={PAYER_CODE_MAX_LENGTH}
                  autoComplete="off"
                  defaultValue={prefill?.payerCode ?? ''}
                />

                <label htmlFor="codes-reason">Means</label>
                <select id="codes-reason" name="canonicalCode" required defaultValue="">
                  <option value="" disabled>
                    Choose a reason…
                  </option>
                  <ReasonOptions />
                </select>

                <label htmlFor="codes-from">In force from</label>
                <input id="codes-from" name="effectiveFrom" type="date" required defaultValue={today} />

                <label htmlFor="codes-to">Until (leave empty for no end)</label>
                <input id="codes-to" name="effectiveTo" type="date" />

                <label htmlFor="codes-source">Where this comes from</label>
                <select id="codes-source" name="source" required defaultValue="customer_confirmed">
                  {PAYER_CODE_SOURCES.map((source) => (
                    <option key={source} value={source}>
                      {SOURCE_LABEL[source]}
                    </option>
                  ))}
                </select>

                <label htmlFor="codes-note">Note: the link, the person or the page</label>
                <input
                  id="codes-note"
                  name="sourceNote"
                  type="text"
                  maxLength={PAYER_CODE_SOURCE_NOTE_MAX_LENGTH}
                  autoComplete="off"
                />

                <label htmlFor="codes-confidence">Confidence</label>
                <select id="codes-confidence" name="confidence" required defaultValue="medium">
                  {PAYER_CODE_CONFIDENCES.map((confidence) => (
                    <option key={confidence} value={confidence}>
                      {confidence}
                    </option>
                  ))}
                </select>

                <button type="submit" className="primary">
                  Add mapping
                </button>
              </form>
            )}
            <p className="empty">
              The code is matched exactly, ignoring capitals and extra spaces. A mapping is never
              edited: to change one, add another with a later start date, and it takes over from that
              day. Your name is recorded on it.
            </p>
          </section>
        ) : (
          <p className="empty">Only an owner or approver can add a mapping.</p>
        )}
      </main>
    </WorkspaceShell>
  );
}
