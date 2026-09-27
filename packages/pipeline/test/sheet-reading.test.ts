import { describe, expect, it } from 'vitest';
import { parseMoneyToCents, type Cents, type SheetMapping } from '@recouple/core-domain';
import type { Classifier, Extractor } from '@recouple/extraction';
import { CSV_MIME, parseWorkbook } from '@recouple/ingest';
import { openHeldDocument } from '../src/open-held';
import { readSheetRows, verifyCellQuote } from '../src/sheet-reading';
import { processUpload, reconcileCase, type IngestInput } from '../src/steps';
import type { PipelineDeps } from '../src/ports';
import { AlwaysCleanScanner, InMemoryStore } from '../src/testing/memory-store';

const ORG = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-0000000000aa';
const DEBTOR = '00000000-0000-4000-8000-0000000000d1';

/** A reader that fails the test if anything asks it: a spreadsheet is read by code. */
const noModel = {
  name: 'none',
  classify: () => {
    throw new Error('a spreadsheet must not be classified by a model');
  },
  extract: () => {
    throw new Error('a spreadsheet must not be extracted by a model');
  },
};

function harness() {
  const store = new InMemoryStore();
  store.addMember(ORG, USER, 'analyst');
  const deps: PipelineDeps = {
    store,
    scanner: new AlwaysCleanScanner(),
    classifier: noModel as unknown as Classifier,
    extractor: noModel as unknown as Extractor,
    now: () => new Date('2026-09-27T12:00:00Z'),
  };
  return { store, deps };
}

function csv(text: string, filename = 'report.csv', source: IngestInput['source'] = 'web_upload'): IngestInput {
  return {
    orgId: ORG,
    filename,
    bytes: new TextEncoder().encode(text),
    source,
    uploadedBy: USER,
  };
}

const REMIT_HEADER = ['Payer', 'Check', 'Date', 'Invoice', 'Gross', 'Deduction', 'Net'];
const LIST_HEADER = ['Reference', 'Invoice', 'Amount', 'Reason', 'Date'];

function mapping(shape: SheetMapping['shape']): Omit<SheetMapping, 'id' | 'version'> {
  return shape === 'remittance'
    ? {
        orgId: ORG,
        debtorId: DEBTOR,
        effectiveFrom: '2026-01-01',
        headerRow: 1,
        sheetName: 'Sheet1',
        headerFingerprint: REMIT_HEADER,
        shape,
        columns: {
          payer_name: 1,
          payment_reference: 2,
          payment_date: 3,
          invoice_number: 4,
          gross_amount: 5,
          deduction_amount: 6,
          net_amount: 7,
        },
        nonLineRule: { firstCellMatches: ['Subtotal'] },
        sign: 'deductions_positive',
        currency: 'USD',
        dateOrder: 'mdy',
        sourceDocumentId: null,
        confirmedBy: USER,
      }
    : {
        orgId: ORG,
        debtorId: DEBTOR,
        effectiveFrom: '2026-01-01',
        headerRow: 1,
        sheetName: 'Sheet1',
        headerFingerprint: LIST_HEADER,
        shape,
        columns: { deduction_reference: 1, invoice_number: 2, deduction_amount: 3, reason_code: 4, deduction_date: 5 },
        nonLineRule: { blankColumn: 1 },
        sign: 'deductions_negative',
        currency: 'USD',
        dateOrder: 'dmy',
        sourceDocumentId: null,
        confirmedBy: USER,
      };
}

const REMITTANCE = [
  REMIT_HEADER.join(','),
  'Sysco,CHK-1,09/01/2026,INV-1,"$1,000.00",$100.00,$900.00',
  'Sysco,CHK-1,09/01/2026,INV-1,$500.00,$50.00,$450.00',
  'Subtotal,,,,,$150.00,',
].join('\n');

function list(references: readonly string[]): string {
  return [
    LIST_HEADER.join(','),
    ...references.map((ref, i) => `${ref},INV-${i},-${100 + i}.00,SHORT,14/09/2026`),
  ].join('\n');
}

describe('reading a spreadsheet by its mapping (ADR 0056)', () => {
  it('reads a remittance, skips its subtotal, and keys two lines on one invoice apart', async () => {
    const { store, deps } = harness();
    await store.recordSheetMapping(mapping('remittance'));
    const result = await processUpload(csv(REMITTANCE), deps);

    expect(result.sheet?.skipped).toBe(1);
    const claims = [...store.cases.values()].map((c) => c.claimId).sort();
    expect(claims).toHaveLength(2);
    expect(claims.every((c) => c?.includes('#'))).toBe(true);
    expect(store.modelCalls).toEqual([]);
    expect(store.resultCells.length).toBeGreaterThan(0);
    expect(store.extractions.at(-1)?.fields.every((f) => f.quoteVerified === true)).toBe(true);
  });

  it('opens one report_row case per row of a deduction list, in its own sign', async () => {
    const { store, deps } = harness();
    await store.recordSheetMapping(mapping('deduction_list'));
    const result = await processUpload(csv(list(['CB-1', 'CB-2'])), deps);

    expect(result.sheet?.opened).toHaveLength(2);
    const cases = [...store.cases.values()];
    expect(cases.every((c) => c.discoveredVia === 'report_row')).toBe(true);
    expect(cases.map((c) => c.deductionAmountCents).sort()).toEqual([10000, 10100]);
    expect(cases.every((c) => c.deductionDate === '2026-09-14')).toBe(true);
    expect(store.modelCalls).toEqual([]);
    // Each stored amount, flipped back to the sheet's sign, is its cell's.
    expect(store.extractions.at(-1)?.fields.every((f) => f.quoteVerified === true)).toBe(true);
  });

  it('reconciles a report_row case against its own row, not the whole list', async () => {
    const { store, deps } = harness();
    await store.recordSheetMapping(mapping('deduction_list'));
    const result = await processUpload(csv(list(['CB-1', 'CB-2'])), deps);
    const opened = result.sheet?.opened.find((c) => c.claimId === 'CB-2');
    const reconciliation = await reconcileCase(opened!.deductionId, deps);
    expect(reconciliation).toBeDefined();
    expect(reconciliation?.findings.some((f) => f.severity === 'blocking' && /deduction_notice/.test(f.message))).toBe(false);
  });

  it('opens nothing for rows already open when the report is exported again', async () => {
    const { store, deps } = harness();
    await store.recordSheetMapping(mapping('deduction_list'));
    const first = Array.from({ length: 90 }, (_, i) => `CB-${i}`);
    await processUpload(csv(list(first), 'week-1.csv'), deps);
    const again = await processUpload(
      csv(list([...first, ...Array.from({ length: 10 }, (_, i) => `NEW-${i}`)]), 'week-2.csv'),
      deps,
    );
    expect(again.sheet?.opened).toHaveLength(10);
    expect(again.sheet?.seenAgain).toBe(90);
    expect(store.cases.size).toBe(100);
  });

  it('holds a header nobody mapped, and opens it with no model call once a person maps it', async () => {
    const { store, deps } = harness();
    const result = await processUpload(csv(list(['CB-1'])), deps);
    expect(result.held?.reason).toBe('no_mapping');
    expect(result.held?.header).toEqual(LIST_HEADER);
    expect(store.cases.size).toBe(0);

    await store.recordSheetMapping(mapping('deduction_list'));
    const opened = await openHeldDocument(store, {
      orgId: ORG,
      documentId: result.ingest.document.documentId,
      confirmedBy: USER,
    });
    expect(opened.opened).toHaveLength(1);
    expect(opened.opened[0]?.discoveredVia).toBe('report_row');
    expect(store.modelCalls).toEqual([]);
    expect(await store.documentHold(result.ingest.document.documentId)).toBeUndefined();
  });

  it('holds an emailed spreadsheet by email, mapping or not', async () => {
    const { store, deps } = harness();
    await store.recordSheetMapping(mapping('deduction_list'));
    const result = await processUpload(
      (({ uploadedBy: _unused, ...rest }) => rest)(csv(list(['CB-1']), 'mail.csv', 'email_in')),
      deps,
    );
    expect(result.held?.reason).toBe('by_email');
    expect(store.cases.size).toBe(0);
  });

  it('holds an emailed spreadsheet nobody mapped by email, keeping its header', async () => {
    const { store, deps } = harness();
    const result = await processUpload(
      (({ uploadedBy: _unused, ...rest }) => rest)(csv(list(['CB-1']), 'mail.csv', 'email_in')),
      deps,
    );
    expect(result.held?.reason).toBe('by_email');
    expect(result.held?.header).toEqual(LIST_HEADER);
    expect(store.cases.size).toBe(0);
  });

  it('makes a row whose money will not read unreadable, never zero', async () => {
    const { store, deps } = harness();
    await store.recordSheetMapping(mapping('deduction_list'));
    const text = `${list(['CB-1'])}\nCB-2,INV-9,abc,SHORT,14/09/2026`;
    const result = await processUpload(csv(text), deps);
    expect(result.sheet?.unreadable).toBe(1);
    expect(result.sheet?.opened).toHaveLength(1);
    expect([...store.cases.values()].map((c) => c.claimId)).toEqual(['CB-1']);
  });
});

describe('verifyCellQuote', () => {
  const wb = parseWorkbook(new TextEncoder().encode(list(['CB-1'])), CSV_MIME);

  it('is true for the cell at the address, and its money', () => {
    const at = { sheetOrdinal: 0, row: 2, column: 3 };
    expect(verifyCellQuote(wb, at, '-100.00', 'lines[0].deduction_amount', parseMoneyToCents('-100.00'))).toBe(true);
    expect(verifyCellQuote(wb, { sheetOrdinal: 0, row: 2, column: 1 }, 'CB-1', 'lines[0].deduction_reference')).toBe(true);
  });

  it('is false for another text, another address or another amount', () => {
    const at = { sheetOrdinal: 0, row: 2, column: 3 };
    expect(verifyCellQuote(wb, at, '-100.01', 'lines[0].deduction_amount', -10001 as Cents)).toBe(false);
    expect(verifyCellQuote(wb, at, '-100.00', 'lines[0].deduction_amount', -10001 as Cents)).toBe(false);
    expect(verifyCellQuote(wb, at, '-100.00', 'lines[0].deduction_amount')).toBe(false);
    expect(verifyCellQuote(wb, { sheetOrdinal: 0, row: 9, column: 3 }, '-100.00', 'x', undefined)).toBe(false);
  });

  it('marks every stored field of a read verified against its cell', () => {
    const read = readSheetRows(wb, { ...mapping('deduction_list'), id: DEBTOR, version: 1 });
    expect(read.reading.fields.length).toBeGreaterThan(0);
    expect(read.reading.fields.every((f) => read.cells.has(f.fieldPath))).toBe(true);
  });
});
