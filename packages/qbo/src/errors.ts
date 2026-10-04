/**
 * What goes wrong when we read a customer's ledger, as types a caller can act
 * on (ADR 0026).
 *
 * The rule these exist to serve: **an empty ledger and an unreadable ledger are
 * different facts.** A customer with no deductions and a customer whose refresh
 * token was revoked both look like "0 invoices" if an error is swallowed — the
 * first is good news and the second is an outage wearing good news as a costume.
 * So nothing in this package catches its own failure and returns `[]`.
 */

/** Base class, so a caller can catch every QBO failure in one place. */
export class QboError extends Error {
  constructor(message: string) {
    super(message);
    // Each subclass also names itself with a literal. `new.target.name` is the
    // class's name only until a bundler minifies it, and these names are
    // recorded (a run's `error_class`, an audit row) and read back by the
    // pages that tell a person what to do.
    this.name = new.target.name;
  }
}

/**
 * The connection cannot be used: a 401 from the API, a refresh Intuit refused,
 * a refresh whose answer we could not read, an expired refresh token, or no
 * stored tokens at all. Every one of them means the same thing operationally —
 * nobody is reading this ledger until a human reconnects it.
 */
export class QboAuthError extends QboError {
  override name = 'QboAuthError';

  /**
   * Set only when the stored sign-in is dead for good (ADR 0046): Intuit
   * refused a refresh with `invalid_grant`, or the refresh token's own expiry
   * has passed. Absent for every other way this error is thrown — our app's
   * credentials refused, a token response we could not read, no tokens stored
   * — none of which a release would answer. Read it with `deadGrantOf`.
   */
  readonly refusal: DeadGrant | undefined;

  constructor(message: string, refusal?: DeadGrant) {
    super(message);
    this.refusal = refusal;
  }
}

/** The two ways a stored QuickBooks sign-in is dead for good (ADR 0046 §1). */
export type DeadGrant = 'grant_refused' | 'refresh_expired';

/**
 * Whether `error` says the stored sign-in is dead for good, and which way.
 *
 * The one place that answers it (ADR 0046 §1): `grant_refused` is Intuit
 * answering a refresh with `invalid_grant`, `refresh_expired` is the refresh
 * token's own expiry having passed. Anything else — `invalid_client`, a rate
 * limit, an outage, a 401 from the accounting API — is `undefined`, because
 * none of them says the customer's grant is gone.
 */
export function deadGrantOf(error: unknown): DeadGrant | undefined {
  return error instanceof QboAuthError ? error.refusal : undefined;
}

/**
 * Intuit answered 429. `retryAfterMs` is `undefined` when the response carried
 * no usable `Retry-After`; a made-up backoff would be a guess, and the caller
 * knows more about its own schedule than we do.
 */
export class QboRateLimited extends QboError {
  override name = 'QboRateLimited';
  constructor(
    message: string,
    readonly retryAfterMs: number | undefined,
  ) {
    super(message);
  }
}

/**
 * Intuit answered, and the answer is not one we can turn into ledger rows: a
 * missing field the port requires, a value of the wrong type, or — the one that
 * matters most on a money path — an amount that will not round-trip at two
 * decimal places. `fieldPath` names the offending field so the report says
 * *which* number it refused rather than "something was wrong".
 */
export class QboMalformedResponse extends QboError {
  override name = 'QboMalformedResponse';
  constructor(
    message: string,
    readonly fieldPath: string,
  ) {
    super(message);
  }
}

/**
 * Everything else: a 4xx or 5xx that is not 401 or 429, a body that is not
 * JSON, a timeout, a DNS failure. `status` is 0 when the request never got an
 * HTTP response at all. `fault` carries Intuit's `Fault` payload when the body
 * had one, because its `code` and `Detail` are what a support ticket needs.
 */
export class QboRequestFailed extends QboError {
  override name = 'QboRequestFailed';
  constructor(
    message: string,
    readonly status: number,
    readonly fault: unknown,
  ) {
    super(message);
  }
}

/**
 * The caller handed us a window we will not put in a query.
 *
 * Not an API failure — a programming error on our side — but typed, because the
 * reason it is checked at all is that `LedgerWindow.from`/`.to` are interpolated
 * into QBO's query language between single quotes. An unvalidated date string is
 * query injection into a customer's ledger, so the dates are required to be
 * exactly `YYYY-MM-DD` and a real calendar day before a request is built.
 */
export class QboInvalidWindow extends QboError {
  override name = 'QboInvalidWindow';
}

/**
 * The caller handed us an id we will not put in a query (ADR 0035 §2).
 *
 * `QboInvalidWindow`'s reason, for ids: `Id in ('…')` interpolates each one
 * between single quotes, and the ids come off the ledger's own `LinkedTxn`
 * rows. QBO's entity ids are decimal digits, so anything else is refused before
 * a request is built.
 */
export class QboInvalidId extends QboError {
  override name = 'QboInvalidId';
}

/**
 * The caller asked for an account setup does not create (ADR 0063 §3).
 *
 * `QboClient.createAccount` sends nothing but one of `SETUP_ACCOUNTS`, exactly:
 * two fixed names, types and detail types. Anything else is refused before a
 * request is built. A programming error on our side, typed for
 * `QboInvalidWindow`'s reason — this is the one place our code writes to a
 * customer's chart of accounts — and it quotes nothing it was handed.
 */
export class QboInvalidAccountSpec extends QboError {
  override name = 'QboInvalidAccountSpec';
}

/**
 * A chart of accounts that did not end within the pages this client was built
 * to read (`maxPages`; ADR 0063 §2). Not a malformed answer: the company has
 * more accounts than a bounded read covers, and a chart read in part would
 * propose accounts from — and look for setup's two names in — only some of
 * it. So nothing is proposed or created from it. Numbers only.
 */
export class QboChartTooLarge extends QboError {
  override name = 'QboChartTooLarge';
  constructor(
    readonly pages: number,
    readonly pageSize: number,
  ) {
    super(`the chart of accounts did not end within ${pages} pages of ${pageSize} accounts`);
  }
}

/**
 * A report that cannot be read whole (ADR 0066 §1). The Reports API does not
 * paginate: `cut_short` is QuickBooks itself stopping at its cell limit and
 * saying so inside the report, `too_many_lines` is a general ledger with more
 * postings than `GENERAL_LEDGER_MAX_LINES`. Either way nothing is returned —
 * a ledger read in part shows an account as quieter than it is — and the
 * answer is a shorter window or fewer accounts. Carries no number out of the
 * customer's books.
 */
export class QboReportTooLarge extends QboError {
  override name = 'QboReportTooLarge';
  constructor(readonly reason: 'cut_short' | 'too_many_lines') {
    super(
      reason === 'cut_short'
        ? 'QuickBooks cut the report short at its own size limit'
        : 'the report has more lines than one read returns',
    );
  }
}

/** What is compared when an account setup created is read back (ADR 0063 §2). */
export type AccountReadBackField = 'Id' | 'Name' | 'AccountType' | 'Active';

/**
 * An account setup created did not read back as it was sent (ADR 0063 §2):
 * its name, its type or `Active` is not what `POST /account` carried, or the
 * read answered for another id. The press stops there, before a map is saved.
 *
 * It names the account id and the fields, never a value read back: whatever
 * that account is called now is the customer's text, not a log line's. Nothing
 * renames, retypes or deletes the account; a person looks at it in QuickBooks.
 */
export class QboAccountReadBackError extends QboError {
  override name = 'QboAccountReadBackError';
  constructor(
    readonly accountId: string,
    readonly mismatch: readonly AccountReadBackField[],
  ) {
    super(`account ${accountId} did not read back as it was created: ${mismatch.join(', ')}`);
  }
}
