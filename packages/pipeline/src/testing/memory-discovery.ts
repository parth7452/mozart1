/**
 * An in-memory `DiscoveryStore`, for the ledger sync's tests.
 *
 * For tests and local development only. It is exported from
 * `@recouple/pipeline/testing`, a separate entry point, so production code
 * cannot reach it by importing the package (CLAUDE.md: no mocks reachable from
 * production paths) — the same split `memory-store.ts` uses.
 *
 * It mirrors the database where that behaviour is load-bearing, and nowhere
 * else:
 *
 * - **Documents dedupe on (org, sha256)**, which is what makes a re-sync of an
 *   unchanged ledger cost nothing, and a case already attached to that document
 *   is returned rather than opened again.
 * - **Identifiers are unique per (org, source, kind, identifier)** — migration
 *   0020's constraint — so a second insert of the same name is the same fact,
 *   not a second row.
 * - **A decline is idempotent per (org, ledger invoice, version)**, which is
 *   what stops a re-sync counting the same dollars twice in the coverage
 *   denominator.
 *
 * What it does not model is anything RLS, the append-only triggers or
 * `openCase`'s debtor resolution do. Those are the database's, and
 * `packages/store-postgres/test/discovery.test.ts` is where they are asked.
 */

import { randomUUID } from 'node:crypto';
import { cents } from '@recouple/core-domain';
import type { KnownDeduction, KnownIdentifier, LedgerExtract } from '@recouple/core-domain';
import type { DiscoveryStore } from '../discovery';

interface LedgerIdentifiers {
  readonly ledgerInvoiceId: string;
  readonly invoiceNumber: string;
}

export interface MemoryCase {
  readonly deductionId: string;
  readonly documentId: string;
  readonly gapCents: number;
  readonly customerName: string;
  readonly deductionDate?: string;
  readonly events: readonly { readonly type: string; readonly payload: Record<string, unknown> }[];
}

export interface MemoryDecline {
  readonly declinedCandidateId: string;
  readonly reason: 'below_economic_floor' | 'duplicate_of_other';
  readonly estimatedRecoverableCents: number;
  readonly discoveredFrom: 'erp_sync';
  readonly decidedBy: string;
  readonly decidedByVersion: string;
  readonly externalIds: Record<string, string>;
  readonly detail?: string;
}

/** The version this double stamps, mirroring `TRIAGE_DECIDED_BY_VERSION`. */
export const MEMORY_TRIAGE_VERSION = 'triage-rules/v1';

export class InMemoryDiscoveryStore implements DiscoveryStore {
  readonly identifiers: KnownIdentifier[] = [];
  readonly deductions: KnownDeduction[] = [];
  readonly cases: MemoryCase[] = [];
  readonly declines: MemoryDecline[] = [];
  /** sha256 → document id, the `findDocumentByHash` of this double. */
  private readonly documentsByHash = new Map<string, string>();
  private readonly caseByDocument = new Map<string, string>();

  constructor(seed: {
    readonly identifiers?: readonly KnownIdentifier[];
    readonly deductions?: readonly KnownDeduction[];
  } = {}) {
    this.identifiers.push(...(seed.identifiers ?? []));
    this.deductions.push(...(seed.deductions ?? []));
  }

  async knownIdentifiers(): Promise<readonly KnownIdentifier[]> {
    return [...this.identifiers];
  }

  async knownDeductions(): Promise<readonly KnownDeduction[]> {
    return [...this.deductions];
  }

  async recordLedgerCase(input: {
    readonly orgId: string;
    readonly extract: LedgerExtract;
    readonly identifiers: LedgerIdentifiers;
    readonly gapCents: number;
    readonly customerName: string;
    readonly gapStatus: string;
    readonly deductionDate?: string;
    readonly possibleDuplicateOf?: {
      readonly deductionId: string;
      readonly basis: readonly string[];
    };
  }): Promise<{ readonly deductionId: string; readonly documentId: string; readonly reused: boolean }> {
    const known = this.documentsByHash.get(input.extract.sha256);
    if (known !== undefined) {
      const onCase = this.caseByDocument.get(known);
      if (onCase !== undefined) {
        this.addIdentifiers(onCase, input.identifiers);
        return { deductionId: onCase, documentId: known, reused: true };
      }
    }

    const documentId = known ?? randomUUID();
    this.documentsByHash.set(input.extract.sha256, documentId);

    const deductionId = randomUUID();
    this.caseByDocument.set(documentId, deductionId);

    const events: { type: string; payload: Record<string, unknown> }[] = [
      {
        type: 'case.discovered',
        payload: {
          document_id: documentId,
          source: 'erp_sync',
          gap_status: input.gapStatus,
          invoice_number: input.identifiers.invoiceNumber,
        },
      },
    ];
    if (input.possibleDuplicateOf !== undefined) {
      events.push({
        type: 'case.possible_duplicate',
        payload: {
          of: input.possibleDuplicateOf.deductionId,
          basis: [...input.possibleDuplicateOf.basis],
        },
      });
    }

    this.cases.push({
      deductionId,
      documentId,
      gapCents: input.gapCents,
      customerName: input.customerName,
      ...(input.deductionDate !== undefined ? { deductionDate: input.deductionDate } : {}),
      events,
    });
    // A case the next sync has to be able to see, exactly as the database would
    // hand it back: without this, the second run of an unchanged ledger would
    // match nothing and open everything again.
    this.deductions.push({
      deductionId,
      amountCents: cents(input.gapCents),
      invoiceNumber: input.identifiers.invoiceNumber,
      ...(input.deductionDate !== undefined ? { deductionDate: input.deductionDate } : {}),
    });
    this.addIdentifiers(deductionId, input.identifiers);

    return { deductionId, documentId, reused: known !== undefined };
  }

  async declineCandidate(input: {
    readonly orgId: string;
    readonly reason: 'below_economic_floor' | 'duplicate_of_other';
    readonly estimatedRecoverableCents: number;
    readonly identifiers: LedgerIdentifiers;
    readonly detail?: string;
  }): Promise<{ readonly declinedCandidateId: string; readonly written: boolean }> {
    const standing = this.declines.find(
      (row) =>
        row.externalIds.ledger_invoice_id === input.identifiers.ledgerInvoiceId &&
        row.decidedByVersion === MEMORY_TRIAGE_VERSION,
    );
    if (standing !== undefined) {
      return { declinedCandidateId: standing.declinedCandidateId, written: false };
    }
    const declinedCandidateId = randomUUID();
    this.declines.push({
      declinedCandidateId,
      reason: input.reason,
      estimatedRecoverableCents: input.estimatedRecoverableCents,
      discoveredFrom: 'erp_sync',
      decidedBy: 'triage-rules',
      decidedByVersion: MEMORY_TRIAGE_VERSION,
      externalIds: {
        ledger_invoice_id: input.identifiers.ledgerInvoiceId,
        invoice_number: input.identifiers.invoiceNumber,
      },
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
    });
    return { declinedCandidateId, written: true };
  }

  async ensureIdentifiers(
    deductionId: string,
    _orgId: string,
    identifiers: LedgerIdentifiers,
  ): Promise<void> {
    this.addIdentifiers(deductionId, identifiers);
  }

  /** Unique per (source, kind, identifier), as migration 0021 has it. */
  private addIdentifiers(deductionId: string, identifiers: LedgerIdentifiers): void {
    for (const row of [
      { kind: 'ledger_invoice_id' as const, identifier: identifiers.ledgerInvoiceId },
      { kind: 'invoice_number' as const, identifier: identifiers.invoiceNumber },
    ]) {
      if (row.identifier.trim() === '') continue;
      const exists = this.identifiers.some(
        (held) =>
          held.source === 'erp_sync' &&
          held.kind === row.kind &&
          held.identifier === row.identifier,
      );
      if (exists) continue;
      this.identifiers.push({
        deductionId,
        source: 'erp_sync',
        kind: row.kind,
        identifier: row.identifier,
      });
    }
  }
}
