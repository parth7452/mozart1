import {
  EVIDENCE_NOT_YET_TYPED,
  reasonInWords,
  type EvidenceChecklist,
  type EvidenceType,
} from '@recouple/core-domain';
import type { CaseDocument } from '@recouple/store-postgres';

/** Each evidence type in words (ADR 0059). */
export const EVIDENCE_LABELS: Readonly<Record<EvidenceType, string>> = {
  signed_pod: 'Signed proof of delivery',
  carrier_signed_bol: 'Carrier-signed bill of lading',
  po: 'Purchase order',
  invoice: 'Invoice',
  asn: 'Advance ship notice',
  packing_list: 'Packing list',
  promo_deal_sheet: 'Promotion deal sheet',
  buyer_approval_email: 'Buyer approval',
  price_agreement: 'Price agreement',
  routing_guide: 'Routing guide',
  remittance_advice: 'Remittance advice',
};

/** The evidence the chosen reason needs, and what the case holds. Pure. */
export function EvidenceChecklistPanel(props: {
  checklist?: EvidenceChecklist | undefined;
  documents: readonly CaseDocument[];
}) {
  const { checklist, documents } = props;
  if (checklist === undefined) {
    return (
      <div className="card" style={{ marginTop: 18 }}>
        <h2 className="section" style={{ marginTop: 0 }}>Evidence</h2>
        <p className="empty">No reason chosen yet. Choose a reason under Decide to see the evidence it needs.</p>
      </div>
    );
  }
  const names = new Map(documents.map((d) => [d.documentId, d.filename === '' ? 'document' : d.filename] as const));
  const links = (ids: readonly string[]) =>
    ids.map((id, i) => (
      <span key={id}>
        {i > 0 ? ', ' : null}
        <a href={`/api/document/${id}`}>{names.get(id) ?? 'document'}</a>
      </span>
    ));
  return (
    <div className="card" style={{ marginTop: 18 }}>
      <h2 className="section" style={{ marginTop: 0 }}>Evidence for {reasonInWords(checklist.reason)}</h2>
      <table>
        <tbody>
          {checklist.rows.map((row) => (
            <tr key={row.evidenceType}>
              <td>{EVIDENCE_LABELS[row.evidenceType]}</td>
              <td>{row.required ? 'Required' : 'Helpful'}</td>
              <td>
                {row.status === 'have' ? (
                  <>Have: {links(row.documentIds)}</>
                ) : row.status === 'possible' ? (
                  <>
                    Possible — check content: {links(row.documentIds)}
                    <br />
                    <small>A message is on the case; whether it is the buyer&apos;s approval is not checked.</small>
                  </>
                ) : (
                  'Missing'
                )}
              </td>
              <td>{row.why}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">
        Checklist version {checklist.version}. &apos;Have&apos; means a document of that type is on the case; its
        content is not checked.
      </p>
      <p className="muted">Not yet tracked as evidence types: {EVIDENCE_NOT_YET_TYPED.join('; ')}.</p>
    </div>
  );
}
