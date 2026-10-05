import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  REASON_FAMILIES,
  cents,
  draftEntries,
  settlementLinesFrom,
  type ReasonFamily,
} from '@recouple/core-domain';
import {
  PostingInputError,
  buildSettlementEntry,
  buildStoredSettlementEntry,
  entryLines,
  postingMemo,
  postingReference,
  settlementStages,
  verifyReadBack,
  type LedgerAccountMap,
  type StoredPostingLine,
} from '../src/posting';
import type { JsonObject } from '../src/reader';

/**
 * ADR 0068 §6: a settlement decision that carries its own lines is posted
 * from them. Nothing here was recorded from QuickBooks.
 */

const MAP: LedgerAccountMap = {
  arAccountId: '1100',
  deductionsReceivableAccountId: '4001',
  writeoffByFamily: Object.fromEntries(REASON_FAMILIES.map((f, i) => [f, String(6000 + i)])) as Record<
    ReasonFamily,
    string
  >,
  unclassifiedWriteoff: '6999',
};
const common = {
  caseId: '7c1e2c1e-0000-4000-8000-000000000001',
  family: 'shortage' as const,
  writebackId: '11111111-2222-3333-4444-555555555555',
  approvedOn: '2026-10-05',
  customerId: '58',
};

type Outcome = 'won' | 'partial' | 'lost' | 'declined';
const settled = fc.integer({ min: 1, max: 1_000_000_000_000 }).chain((a) =>
  fc.tuple(
    fc.constant(a),
    fc.oneof(
      fc.constant<[number, Outcome]>([a, 'won']),
      fc.constant<[number, Outcome]>([0, 'lost']),
      fc.constant<[number, Outcome]>([0, 'declined']),
      a > 1
        ? fc.integer({ min: 1, max: a - 1 }).map((r): [number, Outcome] => [r, 'partial'])
        : fc.constant<[number, Outcome]>([0, 'lost']),
    ),
    fc.option(fc.constantFrom(...REASON_FAMILIES), { nil: undefined }),
  ),
);

describe('the editable lines and the posted lines are one computation', () => {
  it('settlementLinesFrom gives exactly entryLines, line for line', () => {
    fc.assert(
      fc.property(settled, ([a, [r, outcome], family]) => {
        const entries = draftEntries({ amountCents: cents(a), recoveredCents: cents(r), outcome, family });
        const includeFound = outcome === 'declined';
        const editable = settlementLinesFrom(entries, MAP, { includeFound });
        const posted = entryLines(entries, MAP, settlementStages(includeFound));
        expect(
          editable.map((l) => ({
            accountId: l.accountExternalId,
            side: l.debitCents > 0 ? 'Debit' : 'Credit',
            amountCents: l.debitCents > 0 ? l.debitCents : l.creditCents,
          })),
        ).toEqual(posted);
      }),
    );
  });

  it('unedited stored lines build the body the computed path builds', () => {
    fc.assert(
      fc.property(settled, ([a, [r, outcome], family]) => {
        const entries = draftEntries({ amountCents: cents(a), recoveredCents: cents(r), outcome, family });
        const includeFound = outcome === 'declined';
        const computed = buildSettlementEntry({ ...common, family, entries, map: MAP, includeFound });
        const stored = buildStoredSettlementEntry({ ...common, family, lines: computed.lines });
        expect(stored).toEqual(computed);
      }),
    );
  });
});

describe('buildStoredSettlementEntry', () => {
  const lines: readonly StoredPostingLine[] = [
    { accountId: '6100', side: 'Debit', amountCents: cents(30_000), memo: 'Agreed with the buyer' },
    { accountId: '6200', side: 'Debit', amountCents: cents(20_000) },
    { accountId: '4001', side: 'Credit', amountCents: cents(50_000), memo: '' },
  ];

  it('posts the stored lines in order, a typed memo as the line description, our note as the entry memo', () => {
    const posting = buildStoredSettlementEntry({ ...common, lines });
    const reference = postingReference(common.writebackId);
    const ours = postingMemo(common.caseId, 'shortage', reference);
    expect(posting.lines).toEqual([
      { accountId: '6100', side: 'Debit', amountCents: 30_000 },
      { accountId: '6200', side: 'Debit', amountCents: 20_000 },
      { accountId: '4001', side: 'Credit', amountCents: 50_000 },
    ]);
    expect(posting.body['PrivateNote']).toBe(ours);
    expect(posting.body['DocNumber']).toBe(reference);
    const body = posting.body['Line'] as JsonObject[];
    expect(body.map((l) => l['Description'])).toEqual(['Agreed with the buyer', ours, ours]);
    expect(body.map((l) => l['Amount'])).toEqual(['300.00', '200.00', '500.00']);
    expect(
      body.map((l) => {
        const detail = l['JournalEntryLineDetail'] as JsonObject;
        return [
          detail['PostingType'],
          (detail['AccountRef'] as JsonObject)['value'],
          ((detail['Entity'] as JsonObject)['EntityRef'] as JsonObject)['value'],
        ];
      }),
    ).toEqual([
      ['Debit', '6100', '58'],
      ['Debit', '6200', '58'],
      ['Credit', '4001', '58'],
    ]);
  });

  it('refuses lines that do not balance, a non-positive or fractional amount, a bad id, and fewer than two', () => {
    const bad = (edit: StoredPostingLine[]) => () => buildStoredSettlementEntry({ ...common, lines: edit });
    expect(bad([{ ...lines[0]!, amountCents: cents(30_001) }, lines[1]!, lines[2]!])).toThrow(PostingInputError);
    expect(bad([{ ...lines[0]!, amountCents: 0 as never }, lines[1]!, lines[2]!])).toThrow(PostingInputError);
    expect(bad([{ ...lines[0]!, amountCents: 300.5 as never }, lines[1]!, lines[2]!])).toThrow(PostingInputError);
    expect(bad([{ ...lines[0]!, side: 'debit' as never }, lines[1]!, lines[2]!])).toThrow(PostingInputError);
    expect(bad([{ ...lines[0]!, accountId: "1' or 1=1" }, lines[1]!, lines[2]!])).toThrow();
    expect(bad([lines[2]!])).toThrow(PostingInputError);
  });

  it('reads back against the stored lines: an account, a side or a cent that differs is named', () => {
    const posting = buildStoredSettlementEntry({ ...common, lines });
    // What QuickBooks answers with: the same entry, its amounts as JSON numbers.
    type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const echo = (): Loose => {
      const body = JSON.parse(JSON.stringify(posting.body)) as Loose;
      for (const line of body['Line'] as Loose[]) line['Amount'] = Number(line['Amount']);
      return body;
    };
    expect(verifyReadBack(posting, echo())).toBe('match');

    // QuickBooks storing a memo its own way is not a mismatch: no money in it.
    const rememoed = echo();
    rememoed['Line'][0]['Description'] = 'Agreed with the buyer.';
    expect(verifyReadBack(posting, rememoed)).toBe('match');

    const moved = echo();
    moved['Line'][0]['JournalEntryLineDetail']['AccountRef']['value'] = '6005';
    expect(verifyReadBack(posting, moved)).toEqual({ mismatch: ['Line[0].AccountRef'] });

    const resized = echo();
    resized['Line'][1]['Amount'] = 200.01;
    expect(verifyReadBack(posting, resized)).toEqual({ mismatch: ['Line[1].Amount'] });

    const flipped = echo();
    flipped['Line'][2]['JournalEntryLineDetail']['PostingType'] = 'Debit';
    expect(verifyReadBack(posting, flipped)).toEqual({ mismatch: ['Line[2].PostingType'] });

    const short = echo();
    short['Line'].pop();
    expect(verifyReadBack(posting, short)).toEqual({ mismatch: ['Line.length'] });
  });
});
