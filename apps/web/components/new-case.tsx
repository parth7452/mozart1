import type { ReactNode } from 'react';
import {
  MANUAL_ENTRY_MAX_INVOICES,
  MANUAL_ENTRY_NOTES_MAX,
  MANUAL_ENTRY_TEXT_MAX,
  type ManualEntryField,
} from '@recouple/core-domain';
import { browserUploadNotices, type Notice } from '../lib/notices';
import { UPLOAD_ACCEPT, UPLOAD_MAX_MB } from '../lib/upload-limits';
import { NEW_CASE_FILES_HOLDER, NEW_CASE_FILES_INPUT, NewCaseSubmit } from './new-case-submit';
import { NEW_CASE_ANCHOR, NEW_CASE_FIELDS, type NewCasePrefill } from '../lib/manual-case';

/**
 * Opening a case by hand (ADR 0070), as a dialog over the deductions list.
 *
 * No script: the dialog is shown by the CSS `:target` pattern, so `#new-case`
 * in the address opens it and any link to `#` closes it. The sidebar's items
 * are labels for each section's first field, which focus and scroll without
 * touching the address (a link would close the dialog). Pure function of props.
 * The one script is `NewCaseSubmit`, which only takes over a submit that has
 * documents chosen; without it the form posts exactly as before.
 */

export interface NewCaseMember {
  readonly userId: string;
  readonly email: string;
  readonly fullName?: string | undefined;
}

export interface NewCaseDialogProps {
  readonly debtors: readonly { readonly debtorId: string; readonly displayName: string }[];
  /** Members who may write; `read_only` members are left out by the caller. */
  readonly members: readonly NewCaseMember[];
  readonly prefill: NewCasePrefill;
  /** The resolved `nc` notice, if any. */
  readonly notice?: Notice | undefined;
  /** The field a refusal named, marked `aria-invalid`. */
  readonly invalidField?: ManualEntryField | undefined;
  readonly viewerUserId: string;
  /** `yyyy-mm-dd`: the latest deduction date the form offers. */
  readonly today: string;
}

const SECTIONS = [
  { title: 'Deduction', first: 'nc-debtorId' },
  { title: 'Reason & invoices', first: 'nc-reasonCode' },
  { title: 'References', first: 'nc-poNumber' },
  { title: 'Dispute', first: 'nc-disputeAmount' },
  { title: 'Ownership & notes', first: 'nc-assigneeId' },
  { title: 'Documents', first: 'nc-files' },
  { title: 'Add a payer', first: 'nc-displayName' },
] as const;

function Row({
  id,
  label,
  description,
  required = false,
  wide = false,
  children,
}: {
  id: string;
  label: string;
  description?: string;
  required?: boolean;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={wide ? 'setting-row wide' : 'setting-row'}>
      <div className="setting-label">
        <label htmlFor={id}>
          {label}
          {required ? <span className="required-tag">Required</span> : null}
        </label>
        {description === undefined ? null : <p className="setting-description">{description}</p>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

export function NewCaseDialog({
  debtors,
  members,
  prefill,
  notice,
  invalidField,
  viewerUserId,
  today,
}: NewCaseDialogProps) {
  const invalid = (field: ManualEntryField) => (invalidField === field ? { 'aria-invalid': true as const } : {});
  const owner = prefill.assigneeId ?? viewerUserId;

  return (
    <div
      id={NEW_CASE_ANCHOR}
      className="modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-case-title"
    >
      <a href="#" className="modal-backdrop" aria-label="Close" tabIndex={-1}></a>
      <div className="modal-panel">
        <nav className="modal-nav" aria-label="Sections">
          <p className="modal-nav-caption">Open a case</p>
          <ul>
            {SECTIONS.map((section) => (
              <li key={section.title}>
                <label htmlFor={section.first}>{section.title}</label>
              </li>
            ))}
          </ul>
        </nav>
        <div className="modal-body">
          <a href="#" className="modal-close" aria-label="Close">
            ×
          </a>
          <h2 id="new-case-title">Open a case</h2>
          <p className="hint">
            Enter what identifies the deduction. Mozart works out the rest — reason, evidence
            checklist and duplicate check.
          </p>
          {notice === undefined ? null : (
            <p className={notice.tone === 'good' ? 'notice sent' : 'notice bad'}>{notice.text}</p>
          )}
          {debtors.length === 0 ? (
            <p className="notice bad">Add the payer first — use “Add a payer” at the end of this form.</p>
          ) : null}

          {/* The documents' file input belongs to this empty form, so a submit of
              the case form without a script never sends them: it stays
              url-encoded, and the case page's Add evidence card takes them. */}
          <form id={NEW_CASE_FILES_HOLDER} hidden></form>

          <NewCaseSubmit notices={browserUploadNotices()}>
            <section aria-labelledby="nc-s-deduction">
              <h3 id="nc-s-deduction">Deduction</h3>
              <Row id="nc-debtorId" label="Payer" description="The retailer or distributor that deducted" required>
                <select
                  id="nc-debtorId"
                  name="debtorId"
                  required
                  defaultValue={prefill.debtorId ?? ''}
                  {...invalid('debtorId')}
                >
                  <option value="" disabled>
                    Choose a payer…
                  </option>
                  {debtors.map((debtor) => (
                    <option key={debtor.debtorId} value={debtor.debtorId}>
                      {debtor.displayName}
                    </option>
                  ))}
                </select>
              </Row>
              <Row
                id="nc-deductionReference"
                label="Deduction reference"
                description="The payer's deduction or chargeback number"
                required
              >
                <input
                  id="nc-deductionReference"
                  name="deductionReference"
                  required
                  maxLength={MANUAL_ENTRY_TEXT_MAX}
                  defaultValue={prefill.deductionReference ?? ''}
                  {...invalid('deductionReference')}
                />
              </Row>
              <Row id="nc-amount" label="Deduction amount" description="In dollars, as deducted" required>
                <input
                  id="nc-amount"
                  name="amount"
                  required
                  inputMode="decimal"
                  placeholder="1,250.00"
                  defaultValue={prefill.amount ?? ''}
                  {...invalid('amount')}
                />
              </Row>
              <Row id="nc-deductionDate" label="Deduction date" description="When the payer took it" required>
                <input
                  id="nc-deductionDate"
                  name="deductionDate"
                  type="date"
                  required
                  max={today}
                  defaultValue={prefill.deductionDate ?? ''}
                  {...invalid('deductionDate')}
                />
              </Row>
            </section>

            <section aria-labelledby="nc-s-reason">
              <h3 id="nc-s-reason">Reason &amp; invoices</h3>
              <Row
                id="nc-reasonCode"
                label="Payer reason code"
                description="As it appears on the remittance"
                required
              >
                <input
                  id="nc-reasonCode"
                  name="reasonCode"
                  required
                  maxLength={MANUAL_ENTRY_TEXT_MAX}
                  defaultValue={prefill.reasonCode ?? ''}
                  {...invalid('reasonCode')}
                />
              </Row>
              <Row
                id="nc-invoiceNumbers"
                label="Invoice number(s)"
                description={`One per line or separated by commas — up to ${MANUAL_ENTRY_MAX_INVOICES}. One case per deduction; it may name several invoices.`}
                required
                wide
              >
                <textarea
                  id="nc-invoiceNumbers"
                  name="invoiceNumbers"
                  required
                  rows={2}
                  defaultValue={prefill.invoiceNumbers ?? ''}
                  {...invalid('invoiceNumbers')}
                />
              </Row>
            </section>

            <section aria-labelledby="nc-s-references">
              <h3 id="nc-s-references">References</h3>
              <Row id="nc-poNumber" label="PO number" description="Optional">
                <input
                  id="nc-poNumber"
                  name="poNumber"
                  maxLength={MANUAL_ENTRY_TEXT_MAX}
                  defaultValue={prefill.poNumber ?? ''}
                  {...invalid('poNumber')}
                />
              </Row>
              <Row id="nc-paymentReference" label="Check or remittance number" description="Optional">
                <input
                  id="nc-paymentReference"
                  name="paymentReference"
                  maxLength={MANUAL_ENTRY_TEXT_MAX}
                  defaultValue={prefill.paymentReference ?? ''}
                  {...invalid('paymentReference')}
                />
              </Row>
            </section>

            <section aria-labelledby="nc-s-dispute">
              <h3 id="nc-s-dispute">Dispute</h3>
              <Row
                id="nc-disputeAmount"
                label="Amount to dispute"
                description="Leave blank to dispute the full amount"
              >
                <input
                  id="nc-disputeAmount"
                  name="disputeAmount"
                  inputMode="decimal"
                  defaultValue={prefill.disputeAmount ?? ''}
                  {...invalid('disputeAmount')}
                />
              </Row>
              <Row
                id="nc-endRetailerDebtorId"
                label="Via distributor — end retailer"
                description="When a distributor deducted on a retailer's behalf"
              >
                <select
                  id="nc-endRetailerDebtorId"
                  name="endRetailerDebtorId"
                  defaultValue={prefill.endRetailerDebtorId ?? ''}
                  {...invalid('endRetailerDebtorId')}
                >
                  <option value="">None</option>
                  {debtors.map((debtor) => (
                    <option key={debtor.debtorId} value={debtor.debtorId}>
                      {debtor.displayName}
                    </option>
                  ))}
                </select>
              </Row>
            </section>

            <section aria-labelledby="nc-s-ownership">
              <h3 id="nc-s-ownership">Ownership &amp; notes</h3>
              <Row id="nc-assigneeId" label="Owner" description="Who works this case">
                <select id="nc-assigneeId" name="assigneeId" defaultValue={owner} {...invalid('assigneeId')}>
                  {members.map((member) => (
                    <option key={member.userId} value={member.userId}>
                      {member.fullName ?? member.email}
                    </option>
                  ))}
                </select>
              </Row>
              <Row id="nc-notes" label="Notes" description="Why you think it's invalid" wide>
                <textarea id="nc-notes" name="notes" rows={3} maxLength={MANUAL_ENTRY_NOTES_MAX} {...invalid('notes')} />
              </Row>
            </section>

            <section aria-labelledby="nc-s-documents">
              <h3 id="nc-s-documents">Documents</h3>
              <Row
                id={NEW_CASE_FILES_INPUT}
                label="Attach documents"
                description={`Remittance, invoice, BOL/POD or promotion agreement — PDF, image or spreadsheet, up to ${UPLOAD_MAX_MB} MB each. Optional; a case with none opens marked incomplete.`}
                wide
              >
                <input
                  type="file"
                  id={NEW_CASE_FILES_INPUT}
                  name={NEW_CASE_FILES_INPUT}
                  accept={UPLOAD_ACCEPT}
                  multiple
                  form={NEW_CASE_FILES_HOLDER}
                />
              </Row>
            </section>
          </NewCaseSubmit>

          <form method="post" action="/cases/new/payer" className="modal-form">
            <section aria-labelledby="nc-s-payer">
              <h3 id="nc-s-payer">Add a payer</h3>
              {NEW_CASE_FIELDS.filter((name) => name !== 'debtorId').map((name) =>
                prefill[name] === undefined ? null : (
                  <input key={name} type="hidden" name={name} value={prefill[name]} />
                ),
              )}
              <Row id="nc-displayName" label="Retailer or distributor name" description="Payer not on the list?">
                <div className="inline-control">
                  <input id="nc-displayName" name="displayName" required maxLength={MANUAL_ENTRY_TEXT_MAX} />
                  <button type="submit">Add payer</button>
                </div>
              </Row>
            </section>
          </form>
        </div>
      </div>
    </div>
  );
}
