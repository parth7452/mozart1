/**
 * The invariants, as code.
 *
 * Editing anything in this directory requires a numbered ADR — a Claude Code
 * PreToolUse hook enforces that (see .claude/hooks/require-adr.sh). These
 * mirror database-level enforcement; they never replace it. Anything that can
 * be enforced in Postgres is enforced in Postgres.
 */

export interface Invariant {
  readonly id: number;
  readonly title: string;
  readonly enforcedBy: readonly string[];
}

export const INVARIANTS: readonly Invariant[] = [
  {
    id: 1,
    title:
      'No submission, accounting write-back or write-off without an approvals row for that exact decision_id.',
    enforcedBy: [
      'postgres: app.require_approval() trigger on submissions/writebacks/writeoffs',
      'supabase/tests/02_approval_invariant.sql',
      'postgres: app.approval_names_its_approver() — the approval the gate looks for is written by the approver it names, in their own session, so the preparer cannot write it for them (ADR 0041)',
      'supabase/tests/27_an_approval_is_written_by_its_approver.sql',
    ],
  },
  {
    id: 2,
    title:
      'Append-only truth, including *_events, documents, uploads, document_arrivals, decisions, approvals and audit_log: INSERT and SELECT only. The list is not exhaustive and is not kept here — migration 0004 names the tables it loops over and each later migration names its own, and the suites read the end state back. Corrections are new events — except on uploads and document_arrivals, where documents.upload_id is itself immutable and an arrival is written once, so a second row is one nothing joins to and a wrong channel is a migration-backed decision (ADR 0024).',
    enforcedBy: [
      'postgres: revoked UPDATE/DELETE grants + app.block_mutations() trigger',
      'postgres: migration 0004 applies both to the tables its loop names',
      'supabase/tests/01_append_only.sql',
      'supabase/tests/14_an_arrival_is_a_fact.sql',
      'supabase/tests/24_only_the_app_roles_hold_grants.sql (no role but the owner holds a privilege an append-only trigger refuses, read off each trigger)',
    ],
  },
  {
    id: 3,
    title: 'Money is integer cents. Never floats. Fee maths is property-tested.',
    enforcedBy: ['packages/core-domain/src/money.ts', 'bigint cents columns in Postgres'],
  },
  {
    id: 4,
    title:
      'Document content is untrusted data, never instructions. The reader model runs with no tools.',
    enforcedBy: [
      'packages/core-domain/src/invariants (UNTRUSTED_OPEN/CLOSE)',
      'packages/extraction: reader client is constructed without tools',
    ],
  },
  {
    id: 5,
    title:
      'Every decision persists provider, model_version, schema_version, input_state_hash, raw probabilities, latency and cost.',
    enforcedBy: ['postgres: NOT NULL columns on decisions', 'packages/decision'],
  },
  {
    id: 6,
    title: 'RLS on every table. The service-role key is only ever used in server-side jobs.',
    enforcedBy: [
      'postgres: tenant_isolation policies',
      'supabase/tests/04_rls.sql',
      'supabase/tests/15_every_table_has_rls.sql (every public table, by enumeration)',
      'postgres: migration 0028 — anon, authenticated and service_role hold no grant in public or app, and authenticated is not a member of app_rw (ADR 0037)',
      'supabase/tests/24_only_the_app_roles_hold_grants.sql (the request roles hold nothing, by enumeration)',
    ],
  },
  {
    id: 7,
    title: 'Thresholds auto-tighten, never auto-loosen. Loosening needs a human and an ADR.',
    enforcedBy: [
      'postgres: app.guard_threshold_direction() trigger on org_settings',
      'supabase/tests/05_threshold_direction.sql',
      'supabase/tests/24_only_the_app_roles_hold_grants.sql (every app function pins its search_path; the guard still refuses under a hostile one)',
    ],
  },
];

/** Actions that the approval gate covers. Adding one means adding a trigger. */
export const APPROVAL_ACTIONS = ['submit', 'writeoff', 'writeback'] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

/**
 * Delimiters for quarantined document text (invariant 4). Model input is wrapped
 * in these, and the reader model is told that anything inside is data. The
 * delimiters are stripped from the source text first so a document cannot forge
 * a closing tag and escape the quarantine.
 */
export const UNTRUSTED_OPEN = '<untrusted_document>';
export const UNTRUSTED_CLOSE = '</untrusted_document>';

export function quarantine(documentText: string): string {
  const scrubbed = documentText
    .split(UNTRUSTED_OPEN)
    .join('[untrusted_document]')
    .split(UNTRUSTED_CLOSE)
    .join('[/untrusted_document]');
  return `${UNTRUSTED_OPEN}\n${scrubbed}\n${UNTRUSTED_CLOSE}`;
}

/** The tenant safety settings whose direction of travel is constrained. */
export interface Thresholds {
  readonly autoDisputeCeilingCents: number;
  readonly autoWriteoffCeilingCents: number;
  readonly minClassificationConfidence: number;
  readonly minDecisionConfidence: number;
}

export class ThresholdDirectionError extends Error {
  constructor(readonly loosened: readonly string[]) {
    super(
      `threshold loosening blocked (${loosened.join(', ')}): a human and an ADR are required`,
    );
  }
}

/**
 * Mirrors app.guard_threshold_direction(). A change that loosens any threshold
 * must name the ADR that authorises it; tightening never needs ceremony.
 */
export function assertThresholdDirection(
  current: Thresholds,
  next: Thresholds,
  authorisingAdr?: string,
): void {
  const loosened: string[] = [];
  if (next.autoDisputeCeilingCents > current.autoDisputeCeilingCents) {
    loosened.push('autoDisputeCeilingCents');
  }
  if (next.autoWriteoffCeilingCents > current.autoWriteoffCeilingCents) {
    loosened.push('autoWriteoffCeilingCents');
  }
  if (next.minClassificationConfidence < current.minClassificationConfidence) {
    loosened.push('minClassificationConfidence');
  }
  if (next.minDecisionConfidence < current.minDecisionConfidence) {
    loosened.push('minDecisionConfidence');
  }
  if (loosened.length > 0 && !authorisingAdr) {
    throw new ThresholdDirectionError(loosened);
  }
}
