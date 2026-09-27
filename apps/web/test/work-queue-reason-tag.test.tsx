import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReviewQueueRow } from '@recouple/store-postgres';
import { WorkQueue } from '../components/work-queue';
import { withPayerReasonCodes } from '../lib/payer-terms';

const today = new Date('2026-09-23T15:00:00Z');

function row(id: string, extra: Partial<ReviewQueueRow> = {}): ReviewQueueRow {
  return {
    deductionId: `00000000-0000-0000-0000-${id.padStart(12, '0')}`,
    state: 'classified',
    claimId: `CLM-${id}`,
    deductionAmountCents: 10_000,
    createdAt: '2026-09-20',
    discoveredVia: 'ledger',
    hasApproval: false,
    ...extra,
  } as ReviewQueueRow;
}

function render(rows: ReviewQueueRow[]): string {
  return renderToStaticMarkup(
    <WorkQueue
      queue={{ rows, total: rows.length, waitingOnRetailer: 0, limit: 500 }}
      today={today}
      viewer={{ userId: 'u', mayApprove: false }}
    />,
  );
}

describe('the reason tag on a queue row', () => {
  it('is rendered when the row has a reason code', () => {
    expect(render([row('1', { reasonCode: 'SHORT-QTY' })])).toContain('SHORT-QTY');
  });

  it('is absent otherwise', () => {
    expect(render([row('1')])).not.toContain('queue-reason');
  });

  it('takes the own column, else a derived code, and keeps the order', async () => {
    const rows = [row('1', { reasonCodeAsPrinted: 'OWN' }), row('2'), row('3'), row('4')];
    const read = await withPayerReasonCodes(
      {
        async payerTermsForCases(ids) {
          expect(ids).not.toContain(rows[0]!.deductionId);
          return new Map([
            [rows[1]!.deductionId, { kind: 'derived', terms: { reasonCode: 'DER', documentId: 'd', fieldPath: 'lines[0].reason_code', quoteVerified: null } }],
            [rows[2]!.deductionId, { kind: 'conflicting', candidates: [] }],
            [rows[3]!.deductionId, { kind: 'none' }],
          ]);
        },
      },
      { rows, total: 4, waitingOnRetailer: 0, limit: 500 },
    );
    expect(read.rows.map((r) => r.deductionId)).toEqual(rows.map((r) => r.deductionId));
    expect(read.rows.map((r) => r.reasonCode)).toEqual(['OWN', 'DER', undefined, undefined]);
  });
});
