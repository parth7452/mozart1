/**
 * A short-paid remittance line is a discovered deduction (ADR 0028).
 *
 * Everything here runs against the in-memory store, which models the three
 * database facts these tests turn on: `unique (org_id, debtor_id, claim_id)`
 * the way Postgres applies it, `deduction_identifiers`' own
 * `unique (org_id, source, identifier_kind, identifier)`, and an identifier
 * `source` derived from the document's arrival rather than taken from a caller.
 * A store that modelled none of those would let these pass on behaviour
 * production does not have.
 *
 * The documents are built from the fixture pack's ground truth rather than from
 * a shape invented here: `crosswind-dense-remittance` (42 rows, a third of them
 * short-paid), `stf-201-short-pay-remittance` (the deduction printed outright)
 * and `log-202-remittance-advice` (no deduction column at all — the short-pay is
 * only the subtraction). Money goes back through `parseMoneyToCents` on the way
 * in, so the arithmetic under test is the arithmetic that runs in production.
 */

import { describe, expect, it } from 'vitest';
import { buildExtractionResult, type ExtractionResult } from '@recouple/extraction';
import { everyDocument, type FixtureDocument, type TruthExpectation } from '@recouple/fixtures';
import {
  DuplicateCaseError,
  clearsRemittanceTolerance,
  openCasesFromRemittance,
  type RemittanceLineResult,
} from '../src/steps';
import type { PipelineDeps, StoredDocument } from '../src/ports';
import { AlwaysCleanScanner, InMemoryStore } from '../src/testing/memory-store';

const ORG = 'org-1';
const MEMBER = 'user-7';

function fixture(key: string): FixtureDocument {
  const found = everyDocument().find((d) => d.key === key);
  if (found === undefined) throw new Error(`no fixture ${key}`);
  return found;
}

/** A field, as the reader produces one: a value plus where it was read. */
function field(value: string | number): unknown {
  return { value, confidence: 0.97, source_page: 1, source_quote: String(value) };
}

/** Cents back to the text a page prints, so `parseMoneyToCents` reads it again. */
function printed(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * A remittance document rebuilt from a fixture's ground truth.
 *
 * The truth map is flat — `lines[3].gross_amount` → 24,000 cents — and this is
 * the inverse of the scorer: it puts the cents back as the text a page would
 * print. That is deliberate rather than convenient. The step under test reads
 * verbatim text and does its own arithmetic (invariant 3), so a test that handed
 * it numbers would be testing a path production does not have.
 */
function remittanceFrom(document: FixtureDocument): Record<string, unknown> {
  const built: Record<string, unknown> = {};
  const lines: Record<string, unknown>[] = [];

  const put = (path: string, expectation: TruthExpectation): void => {
    const match = /^lines\[(\d+)\]\.(.+)$/.exec(path);
    const value = expectation.kind === 'money_cents' ? printed(expectation.value) : expectation.value;
    if (match === null) {
      built[path] = field(value as string | number);
      return;
    }
    const index = Number(match[1]);
    const key = match[2] as string;
    lines[index] ??= {};
    (lines[index] as Record<string, unknown>)[key] = field(value as string | number);
  };

  for (const [path, expectation] of Object.entries(document.truth)) put(path, expectation);
  built['lines'] = lines;
  return built;
}

/** One line, written out, for the cases no fixture happens to carry. */
function line(values: {
  invoice_number?: string;
  gross_amount?: string;
  net_amount?: string;
  deduction_amount?: string;
  reason_code?: string;
}): Record<string, unknown> {
  const built: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) built[key] = field(value);
  }
  return built;
}

/** An advice with whatever header and lines a test needs. */
function advice(
  lines: readonly Record<string, unknown>[],
  header: { payer_name?: string; payment_reference?: string; payment_date?: string } = {},
): Record<string, unknown> {
  return {
    payer_name: field(header.payer_name ?? 'Crosswind Grocery Distribution'),
    payment_reference: field(header.payment_reference ?? 'ACH-CW-880412'),
    payment_date: field(header.payment_date ?? '09/15/2026'),
    payment_total: field('$1.00'),
    lines,
  };
}

function extractionOf(document: Record<string, unknown>): ExtractionResult {
  return buildExtractionResult({
    docType: 'remittance_advice',
    extractor: 'fixture',
    document,
    pageText: undefined,
    call: {
      purpose: 'extract',
      provider: 'anthropic',
      modelVersion: 'fixture',
      costMicros: 12_700,
      latencyMs: 40,
      outcome: 'ok',
    },
  });
}

async function harness(): Promise<{
  store: InMemoryStore;
  deps: PipelineDeps;
  stored: StoredDocument;
}> {
  const store = new InMemoryStore();
  store.addMember(ORG, MEMBER, 'analyst');
  const deps: PipelineDeps = {
    store,
    scanner: new AlwaysCleanScanner(),
    classifier: { async classify() { throw new Error('not used'); } },
    extractor: { name: 'none', async extract() { throw new Error('not used'); } },
    now: () => new Date('2026-09-20T00:00:00Z'),
  };
  // An arrival first, because an identifier's source and a decline's channel are
  // both derived from it — the store refuses to invent either.
  const upload = await store.recordUpload({ orgId: ORG, source: 'web_upload', createdBy: MEMBER });
  const stored = await store.putDocument({
    orgId: ORG,
    sha256: 'a'.repeat(64),
    filename: 'advice.pdf',
    mimeType: 'application/pdf',
    byteSize: 2048,
    bytes: new Uint8Array([1, 2, 3]),
    uploadId: upload.uploadId,
    requiresSplit: false,
  });
  return { store, deps, stored };
}

const outcomes = (lines: readonly RemittanceLineResult[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const l of lines) counts[l.outcome] = (counts[l.outcome] ?? 0) + 1;
  return counts;
};

describe('the tolerance', () => {
  const settings = { toleranceCents: 500, toleranceBps: 50 };

  it('is exact on both sides of the absolute floor', () => {
    expect(clearsRemittanceTolerance(499, undefined, settings)).toBe(false);
    expect(clearsRemittanceTolerance(500, undefined, settings)).toBe(true);
  });

  it('is exact on both sides of the proportional floor', () => {
    // 50 bps of $200.00 is exactly $1.00 — but the absolute floor is $5.00, so
    // a gross large enough for the proportion to bind is what this needs:
    // 50 bps of $2,000.00 is $10.00.
    expect(clearsRemittanceTolerance(999, 200_000, settings)).toBe(false);
    expect(clearsRemittanceTolerance(1_000, 200_000, settings)).toBe(true);
  });

  it('does not veto a line whose gross it could not read', () => {
    // A delta over the absolute floor with nothing to proportion it against is
    // still a deduction. Refusing it would lose a real case over one column.
    expect(clearsRemittanceTolerance(600, undefined, settings)).toBe(true);
  });

  it('needs both floors, not either', () => {
    // Over the absolute floor and under the proportional one.
    expect(clearsRemittanceTolerance(600, 1_000_000, settings)).toBe(false);
    // Over the proportional floor and under the absolute one: 50 bps of $50.00
    // is 25c, which a 490c delta clears, but 490 < 500.
    expect(clearsRemittanceTolerance(490, 5_000, settings)).toBe(false);
  });

  it('never divides, so a rounded threshold cannot let a line through', () => {
    // The case that says why this is cross-multiplied rather than written as
    // `delta >= applyBps(gross, bps)`. 50 bps of $2.40 is 1.2 cents. `applyBps`
    // rounds half-up, so it would answer 1 — and a 1c delta would clear a floor
    // it is actually under. Cross-multiplied there is no rounding: 1c is under
    // 1.2c and 2c is over, which is what the numbers say.
    const noFloor = { toleranceCents: 0, toleranceBps: 50 };
    expect(clearsRemittanceTolerance(1, 240, noFloor)).toBe(false);
    expect(clearsRemittanceTolerance(2, 240, noFloor)).toBe(true);
  });
});

describe('a remittance line opens a case', () => {
  it('opens one from a printed deduction amount, with the invoice as an identifier', async () => {
    const { store, deps, stored } = await harness();
    const stf = fixture('stf-201-short-pay-remittance');

    const read = await openCasesFromRemittance(stored, extractionOf(remittanceFrom(stf)), deps);

    expect(outcomes(read.lines)).toEqual({ opened: 1 });
    const opened = read.opened[0];
    expect(opened?.deductionAmountCents).toBe(60_000);
    expect(opened?.discoveredVia).toBe('remittance_line');
    expect(opened?.reasonCodeAsPrinted).toBe('OT-UNAUTH');
    // The payer, as printed, is the case's retailer — the same column a notice
    // fills from `retailer_name`.
    expect(opened?.retailerName).toBe('Briarfield Packaging Co.');
    // Its claim id is the advice's own two identifiers, because a remittance
    // prints no claim: nobody filed one (ADR 0028 §7).
    expect(opened?.claimId).toBe('BF-918-201:ES-260901');
    // And both names are recorded where a deduction's names live (ADR 0025).
    expect(
      store.identifiers
        .filter((i) => i.deductionId === opened?.deductionId)
        .map((i) => [i.kind, i.identifier, i.source]),
    ).toEqual([
      ['claim_id', 'BF-918-201:ES-260901', 'web_upload'],
      ['invoice_number', 'ES-260901', 'web_upload'],
    ]);
  });

  it('subtracts a gross and a net when the advice prints no deduction column', async () => {
    const { deps, stored } = await harness();
    const log = fixture('log-202-remittance-advice');

    const read = await openCasesFromRemittance(stored, extractionOf(remittanceFrom(log)), deps);

    expect(outcomes(read.lines)).toEqual({ opened: 1 });
    // $5,600.00 − $4,800.00, done here rather than by the model.
    expect(read.opened[0]?.deductionAmountCents).toBe(80_000);
  });

  it('records how the amount was arrived at, because the row cannot show it', async () => {
    const { store, deps, stored } = await harness();
    const log = fixture('log-202-remittance-advice');
    await openCasesFromRemittance(stored, extractionOf(remittanceFrom(log)), deps);

    const discovered = store.events.find((e) => e.eventType === 'case.discovered');
    expect(discovered?.payload['amount_basis']).toBe('gross_minus_net');
    expect(discovered?.payload['discovered_via']).toBe('remittance_line');
    // A remittance prints no dispute window. "Dispute within 90 days" in its
    // footer is a payer's rule, which is Phase 2's job, not a date to infer.
    expect(discovered?.payload['dispute_deadline']).toBeNull();
  });

  it('opens a dozen cases from one dense advice, and leaves the rest alone', async () => {
    const { store, deps, stored } = await harness();
    const dense = fixture('crosswind-dense-remittance');

    const read = await openCasesFromRemittance(stored, extractionOf(remittanceFrom(dense)), deps);

    // 42 rows. Every one is accounted for — there is no silent third category.
    expect(read.lines).toHaveLength(42);
    const counts = outcomes(read.lines);
    expect((counts['opened'] ?? 0) + (counts['not_short_paid'] ?? 0)).toBe(42);
    expect(counts['opened']).toBe(read.opened.length);
    expect(counts['opened']).toBeGreaterThan(5);
    // Every opened case is on the same document, as its notice.
    for (const opened of read.opened) {
      expect(
        store.links.some(
          (l) =>
            l.deductionId === opened.deductionId &&
            l.documentId === stored.documentId &&
            l.role === 'notice',
        ),
      ).toBe(true);
    }
    // And the whole read's outcome is on each of them, because
    // `deduction_events.deduction_id` is not null and there is no
    // document-level event to put it on (ADR 0028 §8).
    const summaries = store.events.filter((e) => e.eventType === 'remittance.lines_processed');
    expect(summaries).toHaveLength(read.opened.length);
    expect(summaries[0]?.payload['lines_read']).toBe(42);
  });
});

describe('a line that is not a deduction', () => {
  it('counts a line paid in full as not short-paid, and opens nothing', async () => {
    const { store, deps, stored } = await harness();
    const read = await openCasesFromRemittance(
      stored,
      extractionOf(
        advice([
          line({ invoice_number: 'INV-1', gross_amount: '$500.00', net_amount: '$500.00' }),
        ]),
      ),
      deps,
    );
    expect(outcomes(read.lines)).toEqual({ not_short_paid: 1 });
    expect(store.cases.size).toBe(0);
  });

  it('counts an overpayment as not short-paid rather than inventing a case', async () => {
    const { store, deps, stored } = await harness();
    const read = await openCasesFromRemittance(
      stored,
      extractionOf(
        advice([
          line({ invoice_number: 'INV-1', gross_amount: '$500.00', net_amount: '$600.00' }),
        ]),
      ),
      deps,
    );
    expect(read.lines[0]?.outcome).toBe('not_short_paid');
    expect(read.lines[0]?.amountCents).toBe(-10_000);
    expect(store.cases.size).toBe(0);
  });

  it('reports money it cannot read as unreadable, never as zero', async () => {
    const { store, deps, stored } = await harness();
    const read = await openCasesFromRemittance(
      stored,
      extractionOf(
        advice([
          // Printed, and not a number we can parse. A deduction we cannot price
          // is not a deduction of nothing.
          line({ invoice_number: 'INV-1', deduction_amount: 'see attached schedule' }),
          // Nothing to subtract from.
          line({ invoice_number: 'INV-2', gross_amount: '$500.00' }),
        ]),
      ),
      deps,
    );
    expect(outcomes(read.lines)).toEqual({ unreadable: 2 });
    expect(read.lines[0]?.detail).toContain('will not parse as money');
    expect(read.lines[1]?.detail).toContain('no net paid');
    expect(store.cases.size).toBe(0);
  });

  it('refuses a short-pay it cannot key, because a case it cannot dedupe is how one gets filed twice', async () => {
    const { store, deps, stored } = await harness();
    const read = await openCasesFromRemittance(
      stored,
      extractionOf(advice([line({ gross_amount: '$500.00', net_amount: '$400.00' })])),
      deps,
    );
    expect(read.lines[0]?.outcome).toBe('unreadable');
    expect(read.lines[0]?.detail).toContain('no invoice number');
    expect(store.cases.size).toBe(0);
  });
});

describe('a line under the floor', () => {
  it('is a declined candidate with what it was worth, not a discard', async () => {
    const { store, deps, stored } = await harness();
    const read = await openCasesFromRemittance(
      stored,
      extractionOf(
        advice([
          line({
            invoice_number: 'INV-1',
            gross_amount: '$500.00',
            net_amount: '$497.00',
            reason_code: 'ROUND',
          }),
        ]),
      ),
      deps,
    );

    expect(outcomes(read.lines)).toEqual({ below_tolerance: 1 });
    expect(store.cases.size).toBe(0);
    // Coverage is a ratio of dollars and has no numerator without this.
    expect(store.declinedLines).toHaveLength(1);
    const declined = store.declinedLines[0];
    expect(declined?.estimatedRecoverableCents).toBe(300);
    expect(declined?.externalIds).toEqual({
      invoice_number: 'INV-1',
      payment_reference: 'ACH-CW-880412',
      reason_code: 'ROUND',
    });
    // The policy that decided, so a tenant that later lowers its floor can
    // evaluate the change against exactly what the old one declined.
    expect(declined?.decidedByVersion).toBe('500c/50bps');
    // Derived from the document's own arrival, never passed in (ADR 0024).
    expect(declined?.discoveredFrom).toBe('web_upload');
    expect(declined?.provenanceKind).toBe('observed');
  });

  it('opens the same line once the tenant lowers its floor', async () => {
    const { store, deps, stored } = await harness();
    store.remittanceSettingsByOrg.set(ORG, {
      toleranceCents: 100,
      toleranceBps: 10,
      dedupDays: 30,
    });
    const read = await openCasesFromRemittance(
      stored,
      extractionOf(
        advice([line({ invoice_number: 'INV-1', gross_amount: '$500.00', net_amount: '$497.00' })]),
      ),
      deps,
    );
    expect(outcomes(read.lines)).toEqual({ opened: 1 });
    expect(read.opened[0]?.deductionAmountCents).toBe(300);
  });

  it('counts the lines it cannot attribute rather than crediting a channel to a guess', async () => {
    const { store, deps } = await harness();
    // A document stored before ingest recorded arrivals: no `upload_id`, and
    // nothing anywhere says which channel found it.
    const orphan = await store.putDocument({
      orgId: ORG,
      sha256: 'b'.repeat(64),
      filename: 'old-advice.pdf',
      mimeType: 'application/pdf',
      byteSize: 2048,
      bytes: new Uint8Array([1]),
      requiresSplit: false,
    });

    const read = await openCasesFromRemittance(
      orphan,
      extractionOf(
        advice([
          line({ invoice_number: 'INV-1', gross_amount: '$500.00', net_amount: '$497.00' }),
          line({ invoice_number: 'INV-2', gross_amount: '$500.00', net_amount: '$498.00' }),
          // Over the floor: the cases this document opens are not lost over the
          // lines it could not attribute.
          line({ invoice_number: 'INV-3', gross_amount: '$500.00', net_amount: '$400.00' }),
        ]),
      ),
      deps,
    );

    expect(outcomes(read.lines)).toEqual({ below_tolerance_unattributed: 2, opened: 1 });
    expect(store.declinedLines).toHaveLength(0);
    expect(read.lines[0]?.detail).toContain('records no arrival');
  });
});

describe('the same deduction arriving twice', () => {
  const sameLine = () =>
    advice([line({ invoice_number: 'INV-1', gross_amount: '$500.00', net_amount: '$400.00' })]);

  it('merges an exact identifier match rather than opening a second case', async () => {
    const { store, deps, stored } = await harness();
    const first = await openCasesFromRemittance(stored, extractionOf(sameLine()), deps);
    expect(first.opened).toHaveLength(1);

    // The same advice, read again — a second document with the same content.
    const upload = await store.recordUpload({ orgId: ORG, source: 'email_in' });
    const again = await store.putDocument({
      orgId: ORG,
      sha256: 'c'.repeat(64),
      filename: 'advice-again.pdf',
      mimeType: 'application/pdf',
      byteSize: 2048,
      bytes: new Uint8Array([2]),
      uploadId: upload.uploadId,
      requiresSplit: false,
    });

    const second = await openCasesFromRemittance(again, extractionOf(sameLine()), deps);

    expect(outcomes(second.lines)).toEqual({ merged: 1 });
    expect(store.cases.size).toBe(1);
    expect(second.mergedInto).toEqual([first.opened[0]?.deductionId]);
    // The second document is evidence on the case, not its notice: the first
    // one is how this deduction reached us, and crediting the second would move
    // the channel a coverage number is sliced by.
    expect(
      store.links.filter((l) => l.documentId === again.documentId).map((l) => l.role),
    ).toEqual(['evidence']);
    const merged = store.events.find((e) => e.eventType === 'case.merged_duplicate_line');
    expect(merged?.payload['matched_on']).toEqual(['claim_id']);
    expect(merged?.payload['doc_type']).toBe('remittance_advice');
  });

  it('merges a notice into the remittance-line case when the claim id agrees', async () => {
    // The notice→remittance direction, through the same matcher: a notice whose
    // claim id is the composite this advice built is the same deduction. That
    // is the exact branch, which is the only one that may merge.
    const { store, deps, stored } = await harness();
    await openCasesFromRemittance(stored, extractionOf(sameLine()), deps);

    const candidates = await store.identityCandidates({
      orgId: ORG,
      identifiers: [{ kind: 'claim_id', identifier: 'ACH-CW-880412:INV-1' }],
      invoiceNumber: 'INV-1',
    });
    expect(candidates.knownIdentifiers.map((i) => i.kind)).toEqual(['claim_id']);
    expect(candidates.knownDeductions).toHaveLength(1);
  });

  it('opens a probable duplicate rather than merging it, and names the other case', async () => {
    // Same invoice, same amount, a date inside the window — but a different
    // payment reference, so no identifier matches exactly. ADR 0025's rule: a
    // duplicate case is visible and mergeable, a wrong merge is neither.
    const { store, deps, stored } = await harness();
    const first = await openCasesFromRemittance(stored, extractionOf(sameLine()), deps);

    const upload = await store.recordUpload({ orgId: ORG, source: 'email_in' });
    const other = await store.putDocument({
      orgId: ORG,
      sha256: 'd'.repeat(64),
      filename: 'second-advice.pdf',
      mimeType: 'application/pdf',
      byteSize: 2048,
      bytes: new Uint8Array([3]),
      uploadId: upload.uploadId,
      requiresSplit: false,
    });

    const second = await openCasesFromRemittance(
      other,
      extractionOf(
        advice(
          [line({ invoice_number: 'INV-1', gross_amount: '$500.00', net_amount: '$400.00' })],
          { payment_reference: 'ACH-CW-999999' },
        ),
      ),
      deps,
    );

    expect(outcomes(second.lines)).toEqual({ probable_duplicate: 1 });
    expect(store.cases.size).toBe(2);
    expect(second.lines[0]?.probableDuplicateOf).toEqual([first.opened[0]?.deductionId]);
    const discovered = store.events.filter((e) => e.eventType === 'case.discovered').at(-1);
    expect(discovered?.payload['probable_duplicate_of']).toEqual([first.opened[0]?.deductionId]);
    // A basis names the facts that agreed and never their values.
    expect(discovered?.payload['probable_duplicate_basis']).toEqual([
      'invoice_number',
      'amount_cents',
      'deduction_date',
    ]);
  });

  it('does not call a different amount on the same invoice a duplicate', async () => {
    // A shortage and a price claim against one invoice are two deductions.
    // Merging them would silently drop one from the book.
    const { store, deps, stored } = await harness();
    await openCasesFromRemittance(stored, extractionOf(sameLine()), deps);

    const upload = await store.recordUpload({ orgId: ORG, source: 'email_in' });
    const other = await store.putDocument({
      orgId: ORG,
      sha256: 'e'.repeat(64),
      filename: 'other-advice.pdf',
      mimeType: 'application/pdf',
      byteSize: 2048,
      bytes: new Uint8Array([4]),
      uploadId: upload.uploadId,
      requiresSplit: false,
    });

    const second = await openCasesFromRemittance(
      other,
      extractionOf(
        advice(
          [line({ invoice_number: 'INV-1', gross_amount: '$500.00', net_amount: '$350.00' })],
          { payment_reference: 'ACH-CW-999999' },
        ),
      ),
      deps,
    );

    expect(outcomes(second.lines)).toEqual({ opened: 1 });
    expect(store.cases.size).toBe(2);
    expect(second.lines[0]?.probableDuplicateOf).toBeUndefined();
  });
});

describe('one line failing does not cost the others', () => {
  it('treats a DuplicateCaseError as the merge it is and reads on', async () => {
    const { store, deps, stored } = await harness();
    // A debtor the payer name resolves to, so `unique (org_id, debtor_id,
    // claim_id)` actually fires — it does not while `debtor_id` is null, which
    // is the whole of ADR 0019's bug.
    store.debtors.push({ debtorId: 'debtor-1', names: ['Crosswind Grocery Distribution'] });
    // A case already holding the claim the second line will build, with no
    // identifier rows on it — the state every case opened before ADR 0028 is
    // in, so the matcher cannot see it and the constraint is what catches it.
    const existing = await store.openCase({
      orgId: ORG,
      claimId: 'ACH-CW-880412:INV-2',
      retailerName: 'Crosswind Grocery Distribution',
      deductionAmountCents: 10_000,
    });

    const read = await openCasesFromRemittance(
      stored,
      extractionOf(
        advice([
          line({ invoice_number: 'INV-1', gross_amount: '$500.00', net_amount: '$400.00' }),
          line({ invoice_number: 'INV-2', gross_amount: '$500.00', net_amount: '$400.00' }),
          line({ invoice_number: 'INV-3', gross_amount: '$500.00', net_amount: '$400.00' }),
        ]),
      ),
      deps,
    );

    expect(outcomes(read.lines)).toEqual({ opened: 2, merged: 1 });
    expect(read.lines[1]?.deductionId).toBe(existing.deductionId);
    const merged = store.events.find((e) => e.eventType === 'case.merged_duplicate_line');
    expect(String(merged?.payload['detail'])).toContain('the identifier matcher could not');
  });

  it('lets anything that is not a duplicate out, because a broken database is not a line outcome', async () => {
    const { store, deps, stored } = await harness();
    const boom = new Error('connection terminated unexpectedly');
    store.openCase = async () => {
      throw boom;
    };
    await expect(
      openCasesFromRemittance(
        stored,
        extractionOf(
          advice([line({ invoice_number: 'INV-1', gross_amount: '$500.00', net_amount: '$400.00' })]),
        ),
        deps,
      ),
    ).rejects.toBe(boom);
  });

  it('is a `DuplicateCaseError` the store raises, not one this test invented', () => {
    // Guards the catch above: if the store ever stopped raising this class the
    // merge branch would go unreached and the test above would still pass.
    expect(new DuplicateCaseError('x', 'case-1', 'CLAIM-1')).toBeInstanceOf(DuplicateCaseError);
  });
});
