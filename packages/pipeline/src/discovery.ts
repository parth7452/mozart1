/**
 * The ledger sync step (ADR 0028, STRATEGY §5.4 Phase 1.5, §6.3, ADD-7).
 *
 * One window of a customer's accounting ledger in, and out the other end: cases
 * opened for the short-pays nobody surfaced, skips for the deductions we
 * already hold, and a counterfactual-log row for every candidate we decided not
 * to fight. Like every other step here it is a pure function over ports — the
 * accounting source, and the store — so the whole sync runs in a test with no
 * database and no vendor.
 *
 * Order per candidate, and the order is the design:
 *
 *   detectShortPays → resolveIdentity → triageCandidate → record
 *
 * Identity before triage, because "we already hold this" is not a small
 * deduction we chose not to fight and must not be counted as one. Triage before
 * any write, because the decision is a pure function and the writes are not.
 *
 * **Nothing is swallowed.** A `LedgerAnomaly` from `detectShortPays` is carried
 * into the report rather than dropped — an invoice whose arithmetic does not
 * add up is a thing somebody has to look at, not a line to skip quietly. A
 * store error is not caught at all: a sync that could not write is a sync that
 * failed, and a partial run reported as a success is how a coverage number goes
 * wrong (CLAUDE.md: fail loud).
 */

import {
  buildLedgerExtract,
  DEFAULT_MIN_DISPUTE_CENTS,
  detectShortPays,
  resolveIdentity,
  triageCandidate,
} from '@recouple/core-domain';
import type {
  IdentifierKind,
  IdentityResolution,
  KnownDeduction,
  KnownIdentifier,
  LedgerAnomaly,
  LedgerCredit,
  LedgerExtract,
  LedgerInvoice,
  LedgerPayment,
  LedgerWindow,
  ShortPayCandidate,
} from '@recouple/core-domain';

/**
 * The accounting port, as this step needs it.
 *
 * Structurally the `AccountingSource` of `@recouple/adapters` — an
 * `InMemoryAccountingSource` or the QBO adapter satisfies it as it stands —
 * written out here rather than imported so that `pipeline` does not take a
 * dependency on `adapters` for three method signatures. The row types are
 * `core-domain`'s either way, which is where they are declared.
 */
export interface LedgerSource {
  listInvoices(window: LedgerWindow): Promise<readonly LedgerInvoice[]>;
  listPayments(window: LedgerWindow): Promise<readonly LedgerPayment[]>;
  listCredits(window: LedgerWindow): Promise<readonly LedgerCredit[]>;
}

/** What a ledger sync needs to write. `PostgresDiscoveryStore` is one. */
export interface DiscoveryStore {
  knownIdentifiers(orgId: string): Promise<readonly KnownIdentifier[]>;
  knownDeductions(orgId: string): Promise<readonly KnownDeduction[]>;
  recordLedgerCase(input: {
    readonly orgId: string;
    readonly extract: LedgerExtract;
    readonly identifiers: { readonly ledgerInvoiceId: string; readonly invoiceNumber: string };
    readonly gapCents: number;
    readonly customerName: string;
    readonly gapStatus: string;
    readonly deductionDate?: string;
    readonly possibleDuplicateOf?: {
      readonly deductionId: string;
      readonly basis: readonly string[];
    };
  }): Promise<{ readonly deductionId: string; readonly documentId: string; readonly reused: boolean }>;
  declineCandidate(input: {
    readonly orgId: string;
    readonly reason: 'below_economic_floor' | 'duplicate_of_other';
    readonly estimatedRecoverableCents: number;
    readonly identifiers: { readonly ledgerInvoiceId: string; readonly invoiceNumber: string };
    readonly detail?: string;
  }): Promise<{ readonly declinedCandidateId: string; readonly written: boolean }>;
  /** The `exact` branch's only write: the ledger's own name for a deduction. */
  ensureIdentifiers(
    deductionId: string,
    orgId: string,
    identifiers: { readonly ledgerInvoiceId: string; readonly invoiceNumber: string },
  ): Promise<void>;
}

/**
 * The Phase 2 slot STRATEGY ADD-7 reserves, carried and unused.
 *
 * Triage v1 is deterministic rules (ADR 0028 §2). This parameter exists so the
 * seam is visible and named rather than discovered later: when a provider is
 * passed, it will be asked about the residue the rules leave. Passing one today
 * is refused, loudly, because a port with no implementation that silently did
 * nothing would be worse than not having one.
 */
export interface TriageProvider {
  readonly name: string;
}

export interface SyncLedgerInput {
  readonly source: LedgerSource;
  readonly window: LedgerWindow;
  readonly store: DiscoveryStore;
  readonly orgId: string;
  /** Defaults to `DEFAULT_MIN_DISPUTE_CENTS` (ADR 0028 §4). */
  readonly minDisputeCents?: number;
  /** Phase 2. Absent means "no provider", which is the only value v1 accepts. */
  readonly triageProvider?: TriageProvider;
}

/** One case this sync opened. */
export interface OpenedCase {
  readonly deductionId: string;
  readonly documentId: string;
  readonly invoiceExternalId: string;
  readonly gapCents: number;
  /** True when the extract and its case were already here: a repeat sync. */
  readonly reused: boolean;
}

/** A candidate the ledger found that we already hold as a deduction. */
export interface SkippedCandidate {
  readonly invoiceExternalId: string;
  readonly deductionId: string;
  readonly matchedKind: string;
}

/** A candidate we decided not to fight, and the row that says so. */
export interface DeclinedCandidateSummary {
  readonly invoiceExternalId: string;
  readonly reason: 'below_economic_floor' | 'duplicate_of_other';
  readonly estimatedRecoverableCents: number;
  readonly declinedCandidateId: string;
  /** False when this invoice had already been declined under this version. */
  readonly written: boolean;
}

/** A case opened over the top of a probable match, and what it may duplicate. */
export interface PossibleDuplicate {
  readonly deductionId: string;
  readonly ofDeductionId: string;
  readonly basis: readonly string[];
}

export interface SyncReport {
  readonly orgId: string;
  readonly window: LedgerWindow;
  readonly invoicesExamined: number;
  readonly candidates: readonly ShortPayCandidate[];
  readonly opened: readonly OpenedCase[];
  readonly skipped: readonly SkippedCandidate[];
  readonly declined: readonly DeclinedCandidateSummary[];
  readonly anomalies: readonly LedgerAnomaly[];
  readonly possibleDuplicates: readonly PossibleDuplicate[];
}

export class LedgerSyncError extends Error {}

/** The two names a ledger arrival carries, in the kinds migration 0020 admits. */
function arrivalIdentifiers(
  candidate: ShortPayCandidate,
): readonly { kind: IdentifierKind; identifier: string }[] {
  const out: { kind: IdentifierKind; identifier: string }[] = [];
  if (candidate.invoiceExternalId.trim() !== '') {
    out.push({ kind: 'ledger_invoice_id', identifier: candidate.invoiceExternalId });
  }
  if (candidate.invoiceNumber.trim() !== '') {
    out.push({ kind: 'invoice_number', identifier: candidate.invoiceNumber });
  }
  return out;
}

/**
 * Reads one window of a ledger and records what it found.
 *
 * Every candidate reaches exactly one of three outcomes and each of them writes
 * something: a case, an identifier row, or a declined-candidate row. There is
 * no fourth, silent one — that absence is what makes coverage countable
 * (STRATEGY ADD-1).
 */
export async function syncLedger(input: SyncLedgerInput): Promise<SyncReport> {
  if (input.triageProvider !== undefined) {
    // Named rather than ignored. A provider passed today would be silently
    // unused, and a caller believing a model triaged their ledger when rules
    // did is the kind of wrong nobody notices.
    throw new LedgerSyncError(
      `triage v1 is deterministic rules and calls no provider; ${input.triageProvider.name} ` +
        'cannot be used until the Phase 2 decision layer lands (ADR 0028 §2)',
    );
  }

  const minDisputeCents = input.minDisputeCents ?? DEFAULT_MIN_DISPUTE_CENTS;

  const [invoices, payments, credits] = await Promise.all([
    input.source.listInvoices(input.window),
    input.source.listPayments(input.window),
    input.source.listCredits(input.window),
  ]);

  const report = detectShortPays(invoices, payments, credits);

  // Read once, before the loop: the identity state a sync matches against is
  // the state at its start, and re-reading per candidate would let a case this
  // very sync opened become a "probable duplicate" of the next line.
  const knownIdentifiers = await input.store.knownIdentifiers(input.orgId);
  const knownDeductions = await input.store.knownDeductions(input.orgId);

  const byExternalId = new Map<string, LedgerInvoice>();
  for (const invoice of invoices) {
    if (!byExternalId.has(invoice.externalId)) byExternalId.set(invoice.externalId, invoice);
  }

  const opened: OpenedCase[] = [];
  const skipped: SkippedCandidate[] = [];
  const declined: DeclinedCandidateSummary[] = [];
  const possibleDuplicates: PossibleDuplicate[] = [];

  for (const candidate of report.candidates) {
    const invoice = byExternalId.get(candidate.invoiceExternalId);
    if (invoice === undefined) {
      // `detectShortPays` only produces candidates from invoices it was given,
      // so this cannot happen — and if it ever does, it is a bug in the pairing
      // rather than a candidate to skip.
      throw new LedgerSyncError(
        `candidate names invoice ${candidate.invoiceExternalId}, which is not in this window`,
      );
    }

    const resolution: IdentityResolution = resolveIdentity(
      {
        identifiers: arrivalIdentifiers(candidate),
        amountCents: candidate.gapCents,
        invoiceNumber: candidate.invoiceNumber,
        ...(candidate.lastPaymentOn !== undefined
          ? { deductionDate: candidate.lastPaymentOn }
          : {}),
      },
      knownIdentifiers,
      knownDeductions,
    );

    const decision = triageCandidate(candidate, resolution, { minDisputeCents });
    const identifiers = {
      ledgerInvoiceId: candidate.invoiceExternalId,
      invoiceNumber: candidate.invoiceNumber,
    };

    if (decision.kind === 'skip_exact_match') {
      // The one write this branch makes: the ledger's own name for a deduction
      // a notice already found. Never a second case (ADR 0028 §3).
      await input.store.ensureIdentifiers(decision.deductionId, input.orgId, identifiers);
      skipped.push({
        invoiceExternalId: candidate.invoiceExternalId,
        deductionId: decision.deductionId,
        matchedKind: decision.matchedKind,
      });
      continue;
    }

    if (decision.kind === 'decline') {
      const row = await input.store.declineCandidate({
        orgId: input.orgId,
        reason: decision.reason,
        estimatedRecoverableCents: decision.estimatedRecoverableCents,
        identifiers,
        detail: decision.detail,
      });
      declined.push({
        invoiceExternalId: candidate.invoiceExternalId,
        reason: decision.reason,
        estimatedRecoverableCents: decision.estimatedRecoverableCents,
        declinedCandidateId: row.declinedCandidateId,
        written: row.written,
      });
      continue;
    }

    const extract = buildLedgerExtract(candidate, invoice, payments, credits);
    const recorded = await input.store.recordLedgerCase({
      orgId: input.orgId,
      extract,
      identifiers,
      gapCents: candidate.gapCents,
      customerName: candidate.customerName,
      gapStatus: candidate.gapStatus,
      ...(candidate.lastPaymentOn !== undefined
        ? { deductionDate: candidate.lastPaymentOn }
        : {}),
      ...(decision.possibleDuplicateOf !== undefined
        ? { possibleDuplicateOf: decision.possibleDuplicateOf }
        : {}),
    });
    opened.push({
      deductionId: recorded.deductionId,
      documentId: recorded.documentId,
      invoiceExternalId: candidate.invoiceExternalId,
      gapCents: candidate.gapCents,
      reused: recorded.reused,
    });
    if (decision.possibleDuplicateOf !== undefined) {
      possibleDuplicates.push({
        deductionId: recorded.deductionId,
        ofDeductionId: decision.possibleDuplicateOf.deductionId,
        basis: decision.possibleDuplicateOf.basis,
      });
    }
  }

  return {
    orgId: input.orgId,
    window: input.window,
    invoicesExamined: report.invoicesExamined,
    candidates: report.candidates,
    opened,
    skipped,
    declined,
    // Carried, never dropped: an invoice whose arithmetic is untrustworthy
    // produced no candidate, and the only record that it was seen at all is
    // this list.
    anomalies: report.anomalies,
    possibleDuplicates,
  };
}
