import { NextResponse, type NextRequest } from 'next/server';
import type { SetupRow } from '@recouple/qbo';
import {
  AccountMapRequiredError,
  AccountMapTypeError,
  OwnerRequiredError,
  PostingConnectionNotFoundError,
} from '@recouple/store-postgres';
import { requireSession } from '../../../../lib/session';
import { isCrossSite, isUuid, refuseCrossSite } from '../../../../lib/request';
import { type NoticeKey } from '../../../../lib/notices';
import { mayConnectLedger, QBO_SETTINGS_PATH } from '../../../../lib/qbo-connect';
import { qboPostingFromEnv } from '../../../../lib/qbo-posting';
import { postingStoreFor } from '../../../../lib/posting';
import {
  PostingSetupBusyError,
  PostingSetupChartTooLargeError,
  PostingSetupChoiceError,
  PostingSetupCreateRefusedError,
  PostingSetupMappedError,
  PostingSetupNameTakenError,
  PostingSetupNoReceivableError,
  PostingSetupOffError,
  PostingSetupReadBackError,
  PostingSetupRenamedError,
  PostingSetupUnreachableError,
  setUpPosting,
  setupChoicesFrom,
} from '../../../../lib/posting-setup';

/**
 * Long enough for a press that QuickBooks answers slowly to end with its own
 * refusal in words. It waits at most 10 s for a connection to hold its claim
 * on, its requests wait `PRESS_REQUEST_TIMEOUT_MS` each, seven at most, and
 * one token refresh has bounds of its own — a lock connection, the company's
 * lock, Intuit: 240 s at worst, and the minute left is our database's and
 * KMS's (ADR 0063 §2). The platform's default without this — 10 s on Hobby,
 * 15 s on Pro (ADR 0021) — would cut a slow press off with a gateway timeout,
 * a create perhaps asked for and its answer lost. 300 s assumes what ADR 0021
 * does for `/api/inngest`: a plan that honours it.
 */
export const maxDuration = 300;

/** What the owner is told when one of our two names is taken, by row and why. */
const NAME_TAKEN = {
  deductions_receivable: {
    name_taken_wrong_type: 'posting_setup_receivable_wrong_type',
    name_taken_inactive: 'posting_setup_receivable_inactive',
  },
  writeoff: {
    name_taken_wrong_type: 'posting_setup_writeoff_wrong_type',
    name_taken_inactive: 'posting_setup_writeoff_inactive',
  },
} as const satisfies Record<SetupRow, Record<PostingSetupNameTakenError['reason'], NoticeKey>>;

/** What the owner is told when QuickBooks made one of our accounts other than as asked. */
const READ_BACK = {
  deductions_receivable: 'posting_setup_receivable_read_back',
  writeoff: 'posting_setup_writeoff_read_back',
} as const satisfies Record<SetupRow, NoticeKey>;

/**
 * What the owner is told when QuickBooks refused a request while one of our
 * accounts was being created — the create or its read-back, which the refusal
 * does not say — so the account may exist all the same.
 */
const CREATE_REFUSED = {
  deductions_receivable: 'posting_setup_receivable_create_refused',
  writeoff: 'posting_setup_writeoff_create_refused',
} as const satisfies Record<SetupRow, NoticeKey>;

/**
 * What the owner is told when an account setup already made or found for a
 * row is still in their books under another name, and a press would have
 * made a second.
 */
const RENAMED = {
  deductions_receivable: 'posting_setup_receivable_renamed',
  writeoff: 'posting_setup_writeoff_renamed',
} as const satisfies Record<SetupRow, NoticeKey>;

/**
 * Turn on posting (ADR 0063 §2): one owner's press that creates what is
 * missing, saves the map and turns the switch on, in that order.
 *
 * Refused cross-site, and unless this deployment posts at all (`QBO_POSTING`).
 * The session is resolved again, the owner is asked of the database, and the
 * member must still be able to write. Every refusal is a notice key; every log
 * line names ids, class names, HTTP statuses, Intuit fault codes and
 * closed-set words — never an account's name, nor anything QuickBooks said.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (isCrossSite(request)) return refuseCrossSite();

  const session = await requireSession();
  const settings = new URL(QBO_SETTINGS_PATH, request.url);
  const say = (notice: NoticeKey): NextResponse => {
    settings.searchParams.set('qbo', notice);
    return NextResponse.redirect(settings, { status: 303 });
  };

  const poster = qboPostingFromEnv();
  if (poster === undefined) return say('posting_off');
  if (!mayConnectLedger(session.org.role)) return say('posting_role');

  const form = await request.formData();
  const connectionId = form.get('connectionId');
  if (!isUuid(connectionId)) return say('posting_unknown_connection');
  const choices = setupChoicesFrom(form);
  if (choices === undefined) return say('posting_setup_invalid');

  const identity = { orgId: session.org.orgId, userId: session.userId };
  const store = postingStoreFor(session);
  if (!(await store.memberMayWrite())) return say('posting_role');

  try {
    const { mapId, created } = await setUpPosting({ store, poster, identity }, { connectionId, choices });
    console.info(
      `[recouple] posting set up: connection ${connectionId} org ${identity.orgId}, map ${mapId}, ` +
        `created ${created.length === 0 ? 'none' : created.join(' and ')}`,
    );
    return say(
      created.length === 0
        ? 'posting_set_up'
        : created.length === 1
          ? 'posting_set_up_created_one'
          : 'posting_set_up_created_two',
    );
  } catch (cause) {
    const notice = refusal(cause);
    if (notice === undefined) throw cause;
    const quickBooks =
      cause instanceof PostingSetupUnreachableError ||
      cause instanceof PostingSetupReadBackError ||
      cause instanceof PostingSetupCreateRefusedError ||
      (cause instanceof PostingSetupOffError && cause.reason === 'no_client');
    (quickBooks ? console.error : console.warn)(
      `[recouple] posting setup refused (${(cause as Error).name}${detail(cause)}), ` +
        `connection ${connectionId} org ${identity.orgId}`,
    );
    return say(notice);
  }
}

/** The notice for a named refusal, or nothing for an error that is not one. */
function refusal(cause: unknown): NoticeKey | undefined {
  if (cause instanceof PostingSetupOffError) {
    return cause.reason === 'not_posting' ? 'posting_off' : 'posting_setup_not_configured';
  }
  if (cause instanceof OwnerRequiredError) return 'posting_role';
  if (cause instanceof PostingSetupBusyError) return 'posting_setup_busy';
  if (cause instanceof PostingConnectionNotFoundError) return 'posting_unknown_connection';
  if (cause instanceof PostingSetupMappedError) return 'posting_setup_mapped';
  if (cause instanceof PostingSetupChartTooLargeError) return 'posting_setup_chart_too_large';
  if (cause instanceof PostingSetupNoReceivableError) return 'posting_setup_no_receivable';
  if (cause instanceof PostingSetupChoiceError) return 'posting_setup_choice';
  if (cause instanceof PostingSetupNameTakenError) return NAME_TAKEN[cause.row][cause.reason];
  if (cause instanceof PostingSetupRenamedError) return RENAMED[cause.row];
  if (cause instanceof PostingSetupReadBackError) return READ_BACK[cause.row];
  if (cause instanceof PostingSetupCreateRefusedError) return CREATE_REFUSED[cause.row];
  if (cause instanceof PostingSetupUnreachableError) return 'posting_setup_unreachable';
  if (cause instanceof AccountMapTypeError) return 'posting_setup_map_types';
  if (cause instanceof AccountMapRequiredError) return 'posting_needs_map';
  return undefined;
}

/**
 * A refusal's closed-set particulars, for the log line: rows, reasons, ids,
 * class names, and Intuit's status and fault code (ADR 0060 §6).
 */
function detail(cause: unknown): string {
  if (cause instanceof PostingSetupNameTakenError) {
    return `: ${cause.row} ${cause.reason}, account ${cause.accountId}`;
  }
  if (cause instanceof PostingSetupRenamedError) return `: ${cause.row} account ${cause.accountId}`;
  if (cause instanceof PostingSetupBusyError) return `: ${cause.reason}`;
  if (cause instanceof PostingSetupChartTooLargeError) {
    return `: over ${cause.pages} pages of ${cause.pageSize}`;
  }
  if (cause instanceof PostingSetupUnreachableError) {
    return (
      `: at ${cause.step}${cause.row === undefined ? '' : ` of ${cause.row}`}, ${cause.causeClass}` +
      answered(cause.httpStatus, cause.faultCode)
    );
  }
  if (cause instanceof PostingSetupReadBackError) {
    return `: ${cause.row} account ${cause.accountId}, mismatch ${cause.mismatch.join(' ')}`;
  }
  if (cause instanceof PostingSetupCreateRefusedError) {
    return `: ${cause.row}${answered(cause.httpStatus, cause.faultCode)}`;
  }
  if (cause instanceof PostingSetupChoiceError || cause instanceof AccountMapTypeError) {
    return `: ${cause.fields.join(', ')}`;
  }
  if (cause instanceof PostingSetupOffError) return `: ${cause.reason}`;
  return '';
}

/** What Intuit answered, when it answered: a status and a fault code, never its words. */
function answered(httpStatus: number | undefined, faultCode: string | undefined): string {
  return (
    `${httpStatus === undefined ? '' : `, HTTP ${httpStatus}`}` +
    `${faultCode === undefined ? '' : `, fault ${faultCode}`}`
  );
}
