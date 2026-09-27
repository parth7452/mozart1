// What the payer's own documents say about a case's reason, derived at read
// time from the notices and remittances a person linked to it. Nothing here is
// stored: a ledger case keeps `reason_code_as_printed` null, and this answer
// is what the case page, the work queue and the packet show instead.
//
// The invoice number is never identity here. It only picks a line inside a
// remittance that is already linked to the case.
import { type Cents } from './money';
import { identifierMatchKey } from './identity';

export interface PayerTerms {
  reasonCode?: string;
  deductionReference?: string; // from deduction_notice lines only
  documentId: string;
  fieldPath: string; // e.g. 'lines[2].reason_code' (or deduction_reference if no code)
  quoteVerified: boolean | null;
}

export type PayerTermsAnswer =
  | { kind: 'own' }
  | { kind: 'derived'; terms: PayerTerms }
  | { kind: 'none' }
  | { kind: 'conflicting'; candidates: PayerTerms[] };

export interface PayerTermsLine {
  documentId: string;
  docType: 'deduction_notice' | 'remittance_advice';
  index: number;
  reasonCode?: string;
  deductionReference?: string;
  /** notice: deduction_amount; remittance: deduction_amount else gross − net (caller computes via subCents) */
  amountCents?: Cents;
  invoiceNumber?: string;
  /** of the reason_code field (else of deduction_reference) */
  quoteVerified: boolean | null;
}

function termsOf(line: PayerTermsLine): PayerTerms | undefined {
  const reference = line.docType === 'deduction_notice' ? line.deductionReference : undefined;
  if (line.reasonCode === undefined && reference === undefined) return undefined;
  return {
    ...(line.reasonCode === undefined ? {} : { reasonCode: line.reasonCode }),
    ...(reference === undefined ? {} : { deductionReference: reference }),
    documentId: line.documentId,
    fieldPath: `lines[${line.index}].${line.reasonCode === undefined ? 'deduction_reference' : 'reason_code'}`,
    quoteVerified: line.quoteVerified,
  };
}

export function payerTermsFor(input: {
  amountCents: Cents;
  invoiceKeys: readonly string[];
  lines: readonly PayerTermsLine[];
}): Exclude<PayerTermsAnswer, { kind: 'own' }> {
  const keys = new Set(input.invoiceKeys);
  const sorted = [...input.lines].sort((a, b) =>
    a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : a.index - b.index,
  );
  const qualifying: PayerTerms[] = [];
  for (const line of sorted) {
    if (line.amountCents === undefined || line.amountCents !== input.amountCents) continue;
    if (line.docType === 'remittance_advice') {
      if (line.invoiceNumber === undefined || !keys.has(identifierMatchKey(line.invoiceNumber))) continue;
    }
    const terms = termsOf(line);
    if (terms !== undefined) qualifying.push(terms);
  }
  if (qualifying.length === 0) return { kind: 'none' };
  const distinct = new Map<string, PayerTerms>();
  for (const t of qualifying) {
    const key = JSON.stringify([t.reasonCode ?? null, t.deductionReference ?? null]);
    if (!distinct.has(key)) distinct.set(key, t);
  }
  if (distinct.size === 1) return { kind: 'derived', terms: qualifying[0]! };
  return { kind: 'conflicting', candidates: [...distinct.values()] };
}
