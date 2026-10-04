import {
  isStorablePayerCode,
  normalisePayerCode,
  PAYER_CODE_SOURCE_WORDS,
  REASON_WORDS,
  type PayerCodeMapRow,
} from '@recouple/core-domain';

/**
 * Settings → Reason codes' pure half (ADR 0066): who may add a mapping, the
 * words a mapping is shown in, the page's own notices, and the link that
 * prefills the form. No server imports, so the views and the routes share one
 * answer.
 */

export const REASON_CODES_PATH = '/settings/reason-codes';

/**
 * Adding a mapping is an owner's or approver's. The database says the same
 * (`payer_code_maps`' insert policy); this is the button not shown.
 */
export function mayMapPayerCodes(role: string): boolean {
  return role === 'owner' || role === 'approver';
}

/** "Shortage deducted … (mapped by the customer, high)". */
export function mappingWords(map: Pick<PayerCodeMapRow, 'canonicalCode' | 'source' | 'confidence'>): {
  readonly reason: string;
  readonly provenance: string;
} {
  return {
    reason: REASON_WORDS[map.canonicalCode],
    provenance: `mapped by ${PAYER_CODE_SOURCE_WORDS[map.source]}, ${map.confidence} confidence`,
  };
}

/** What the form starts with: a debtor and a code, both optional. */
export interface ReasonCodePrefill {
  readonly debtorId?: string;
  readonly payerCode?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The prefill a link asked for, validated: a debtor that is a UUID and a code
 * the table would take once normalised. Anything else is dropped, never
 * passed on, because a query string is a thing anybody can type. The value
 * only fills an input a person then reads and submits.
 */
export function prefillFrom(params: { readonly debtor?: unknown; readonly code?: unknown }): ReasonCodePrefill {
  const debtorId = typeof params.debtor === 'string' && UUID.test(params.debtor) ? params.debtor : undefined;
  const code = typeof params.code === 'string' ? normalisePayerCode(params.code) : undefined;
  const payerCode = code !== undefined && isStorablePayerCode(code) ? code : undefined;
  return {
    ...(debtorId === undefined ? {} : { debtorId }),
    ...(payerCode === undefined ? {} : { payerCode }),
  };
}

/** The settings page with the form prefilled for one debtor and one code. */
export function mapItHref(debtorId: string, payerCode: string): string {
  const query = new URLSearchParams({ debtor: debtorId, code: payerCode });
  return `${REASON_CODES_PATH}?${query.toString()}#add-mapping`;
}

/**
 * Every sentence this page says back after a write, and nothing else. A notice
 * travels as a key (`lib/notices.ts` says why); an unknown key renders nothing.
 * Its own table so no other page can be made to say these.
 */
export const REASON_CODE_NOTICES = {
  codes_mapped: { tone: 'good', text: 'mapping added. Cases printing that code now show it.' },
  codes_role: { tone: 'bad', text: 'only an owner or approver can add a mapping; nothing changed' },
  codes_invalid: {
    tone: 'bad',
    text:
      'that mapping could not be read: it needs a payer, a code of at most 64 characters, a reason, ' +
      'a start date, a source and a confidence. Nothing changed.',
  },
  codes_dates: { tone: 'bad', text: 'the end date is before the start date; nothing changed' },
  codes_already: {
    tone: 'bad',
    text:
      'that payer already has a mapping for this code starting on that date. ' +
      'To change it, add one with a later start date. Nothing changed.',
  },
  codes_debtor: { tone: 'bad', text: 'that payer is not one of this workspace’s; nothing changed' },
  codes_failed: { tone: 'bad', text: 'that did not go through, and nothing changed. Try again.' },
} as const satisfies Record<string, { readonly tone: 'good' | 'bad'; readonly text: string }>;

export type ReasonCodeNoticeKey = keyof typeof REASON_CODE_NOTICES;

export function resolveReasonCodeNotice(
  key: unknown,
): { readonly tone: 'good' | 'bad'; readonly text: string } | undefined {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(REASON_CODE_NOTICES, key)
    ? REASON_CODE_NOTICES[key as ReasonCodeNoticeKey]
    : undefined;
}
