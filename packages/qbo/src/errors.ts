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
    this.name = new.target.name;
  }
}

/**
 * The connection cannot be used: a 401 from the API, a refresh Intuit refused,
 * a refresh whose answer we could not read, an expired refresh token, or no
 * stored tokens at all. Every one of them means the same thing operationally —
 * nobody is reading this ledger until a human reconnects it.
 */
export class QboAuthError extends QboError {}

/**
 * Intuit answered 429. `retryAfterMs` is `undefined` when the response carried
 * no usable `Retry-After`; a made-up backoff would be a guess, and the caller
 * knows more about its own schedule than we do.
 */
export class QboRateLimited extends QboError {
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
export class QboInvalidWindow extends QboError {}
