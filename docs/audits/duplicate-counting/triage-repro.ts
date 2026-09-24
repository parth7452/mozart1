import { cents, resolveIdentity, triageCandidate } from '../../../packages/core-domain/src/index.ts';

const known = [
  { deductionId: 'N', source: 'web_upload', kind: 'invoice_number' as const, identifier: 'INV-1' },
  { deductionId: 'R', source: 'email_in', kind: 'invoice_number' as const, identifier: 'INV-1' },
];
// syncLedger's arrivalIdentifiers(candidate): ledger_invoice_id + invoice_number
const r = resolveIdentity(
  { identifiers: [{ kind: 'ledger_invoice_id', identifier: '71' }, { kind: 'invoice_number', identifier: 'INV-1' }],
    amountCents: cents(100000), invoiceNumber: 'INV-1', deductionDate: '2026-09-01' },
  known, [],
);
const cand = { gapCents: 100000 } as never;
console.log('ledger vs N+R:', JSON.stringify(r), JSON.stringify(triageCandidate(cand, r, { minDisputeCents: 2500 })));

// probable + below floor -> declined, not flagged
const open = [{ deductionId: 'N2', amountCents: cents(2000), invoiceNumber: 'INV-9', deductionDate: '2026-09-01' }];
const p = resolveIdentity(
  { identifiers: [{ kind: 'ledger_invoice_id', identifier: '90' }], amountCents: cents(2000), invoiceNumber: 'INV-9', deductionDate: '2026-09-03' },
  [], open,
);
console.log('ledger probable below floor:', JSON.stringify(p), JSON.stringify(triageCandidate({ gapCents: 2000 } as never, p, { minDisputeCents: 2500 })));

// chain: A Jan 1, B Jan 6, C Jan 11, tolerance 7: C is probable of B only
const ab = [
  { deductionId: 'A', amountCents: cents(50000), invoiceNumber: 'INV-5', deductionDate: '2026-01-01' },
  { deductionId: 'B', amountCents: cents(50000), invoiceNumber: 'INV-5', deductionDate: '2026-01-06' },
];
console.log('C vs A,B:', JSON.stringify(resolveIdentity(
  { identifiers: [], amountCents: cents(50000), invoiceNumber: 'INV-5', deductionDate: '2026-01-11' }, [], ab)));
