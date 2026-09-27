import type { PostgresStore, ReviewQueueRead } from '@recouple/store-postgres';

/**
 * The review queue's page with each row's payer reason code: the case's own
 * `reason_code_as_printed`, else the one derived from the payer's documents
 * linked to it (`payerTermsForCases`, the one matcher). Disagreeing or absent
 * terms leave the row without a code. The order is untouched.
 */
export async function withPayerReasonCodes(
  store: Pick<PostgresStore, 'payerTermsForCases'>,
  read: ReviewQueueRead,
): Promise<ReviewQueueRead> {
  const needed = read.rows.filter((row) => row.reasonCodeAsPrinted === undefined);
  const answers = await store.payerTermsForCases(needed.map((row) => row.deductionId));
  return {
    ...read,
    rows: read.rows.map((row) => {
      if (row.reasonCodeAsPrinted !== undefined) return { ...row, reasonCode: row.reasonCodeAsPrinted };
      const answer = answers.get(row.deductionId);
      return answer?.kind === 'derived' && answer.terms.reasonCode !== undefined
        ? { ...row, reasonCode: answer.terms.reasonCode }
        : row;
    }),
  };
}
