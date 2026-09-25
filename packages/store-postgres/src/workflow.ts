/**
 * The Phase 3 workflow, on Postgres (ADR 0020).
 *
 * A human decides, our code assembles a packet, a *different* human approves
 * it, somebody files it and records what the portal said, and somebody records
 * what came back. Five writes, each one a step through the case state machine,
 * each one inside the tenant's own transaction as `app_rw`.
 *
 * Three things this file is careful about, in order of how much they would cost
 * to get wrong:
 *
 *  1. **It cannot reach the far side of the gate.** No submission exists
 *     without an `approvals` row for that exact decision on that exact
 *     deduction, and that is a trigger (migration 0005), not a check here. What
 *     this file adds is the *hash* equality — the packet submitted is the
 *     packet approved — which lives here deliberately so the gate's own
 *     function keeps carrying one rule and only one (ADR 0020 §2).
 *  2. **Every refusal has a name.** The database refuses in its own words;
 *     those words are translated into the typed errors in
 *     `@recouple/pipeline`'s `ports.ts`, so a route can tell a rule from a bug
 *     with `instanceof CaseWorkflowError` and never has to match on a string.
 *     Each translation has a test that proves it.
 *  3. **Money stays integer cents.** A deduction amount is a bigint and is read
 *     as text; it is compared as `BigInt` and written to the event as digits,
 *     never through a JS number that could round it (invariant 3).
 *
 * The functions here take a `PoolClient` rather than opening their own
 * transactions: `PostgresStore.withTenant` is the one place the role and the
 * tenant claims are set, and a state move plus its event plus the projection
 * update are one transaction or they are nothing.
 */

import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  applyTransition,
  buildPacketNarrative,
  isCanonicalReasonCode,
  MAX_RATIONALE_LENGTH,
  packetContentHash,
  PacketError,
  type CanonicalReasonCode,
  type CaseState,
  type PacketDocument,
} from '@recouple/core-domain';
import {
  ActorIsNotTheSessionError,
  CaseAlreadyDeclinedError,
  CaseNotVisibleError,
  CaseWorkflowError,
  ConfirmationNumberRequiredError,
  DecisionNotForCaseError,
  DecisionNotFoundError,
  DuplicateApprovalError,
  DuplicateSubmissionError,
  DuplicateVerdictAlreadyRecordedError,
  NoSuchDuplicatePairError,
  InvalidRecoveryAmountError,
  isMergeRefusal,
  MergeRefusedError,
  NoApprovalForSubmissionError,
  NotACanonicalReasonError,
  NothingToSendError,
  PacketAfterApprovalError,
  PacketHashMismatchError,
  PacketNotBuildableError,
  PacketNotForDecisionError,
  PreparerCannotApproveError,
  RationaleRequiredError,
  RationaleTooLongError,
  WrongCaseStateError,
  WrongRoleError,
  type ApprovalRecord,
  type CaseMerges,
  type CaseOutcome,
  type CaseWorkflow,
  type DuplicateCandidateCase,
  type DuplicateVerdict,
  type DuplicateVerdictRecord,
  type HumanDecisionRecord,
  type MergeOutcome,
  type MergeRecord,
  type MergeRefusal,
  type OutcomeRecord,
  type PacketRecord,
  type PossibleDuplicatePair,
  type SubmissionRecord,
  type UnmergeRecord,
  type WorkflowSubmissionChannel,
} from '@recouple/pipeline';
import type { TenantContext } from './store';

// ---------------------------------------------------------------------------
// What a human decision is stamped with (ADR 0020 §1)
// ---------------------------------------------------------------------------

/** Schema B is the validity question. `schema_id` says what was asked. */
export const HUMAN_SCHEMA_ID = 'B';
/** The human form is its own form, so it carries its own version. */
export const HUMAN_SCHEMA_VERSION = 'human-1';
/** `provider` says who answered. */
export const HUMAN_PROVIDER = 'human';
/**
 * `decisions.model_version` is `not null`, and a human is not a model version.
 * Writing a model's name here would be a lie a later cost query would believe.
 */
export const HUMAN_MODEL_VERSION = 'human';

/** Who `app.member_may_write()` lets write (migration 0010). */
const WRITER_ROLES = ['owner', 'approver', 'analyst'] as const;
/** Who `app.enforce_separation_of_duties()` lets approve (migration 0005). */
const APPROVER_ROLES = ['owner', 'approver'] as const;

// ---------------------------------------------------------------------------
// Refusals only this store can reach
// ---------------------------------------------------------------------------
//
// `DuplicateApprovalError`, `CaseAlreadyDeclinedError` and the rest of the
// workflow's named refusals live in `@recouple/pipeline`'s `ports.ts`, where
// both stores get the same class and a caller's `instanceof` holds whichever
// one it was handed. What stays here is what only a database can refuse: the
// translations of its triggers and a foreign key. Each is still a
// `CaseWorkflowError` with its own name — never the bare base, which a caller
// cannot tell one rule from another by.

/**
 * A human decision that does not name its own author.
 *
 * `app.human_decision_names_its_author()` (migration 0016) compares
 * `prepared_by` to `app.current_user_id()`, and
 * `decisions_human_names_its_preparer` makes the column not-null for a human
 * row. `requireCaller` should have caught this first; when it did not, the
 * database is the referee and its words are carried rather than replaced.
 */
export class HumanDecisionAuthorError extends CaseWorkflowError {
  constructor(readonly detail: string) {
    super(`decide refused: a human decision is written by the person it names (${detail})`);
    this.name = 'HumanDecisionAuthorError';
  }
}

/**
 * An approval that does not name its own author.
 *
 * `app.approval_names_its_approver()` (migration 0031, ADR 0041) compares
 * `approver_id` to `app.current_user_id()`, which is what makes separation of
 * duties judge the person approving rather than the name they wrote.
 * `requireCaller` should have caught this first; when it did not, the database
 * is the referee and its words are carried rather than replaced.
 */
export class ApprovalAuthorError extends CaseWorkflowError {
  constructor(readonly detail: string) {
    super(`approve refused: an approval is written by the person it names (${detail})`);
    this.name = 'ApprovalAuthorError';
  }
}

/**
 * An approval naming a hash no packet was assembled under.
 *
 * The `approvals_packet_is_a_real_packet` foreign key onto
 * `packets (decision_id, content_hash)` — without it, 32 arbitrary bytes would
 * read as a human authorising a packet nobody built (ADR 0020 §2).
 */
export class ApprovedPacketMissingError extends CaseWorkflowError {
  constructor(readonly decisionId: string) {
    super(
      `approve refused: no packet with that hash was assembled for decision ${decisionId}`,
    );
    this.name = 'ApprovedPacketMissingError';
  }
}

/**
 * An approval that named no packet at all.
 *
 * `approvals.packet_hash` is nullable because `writeoff` and `writeback` have
 * no packet (ADR 0020 §2), and the foreign key is `MATCH SIMPLE`, so the
 * database accepts a null here. A `submit` approval naming nothing authorises
 * nothing in particular, and this store refuses to file against one.
 */
export class ApprovalNamesNoPacketError extends CaseWorkflowError {
  constructor(readonly approvalId: string) {
    super(
      `submit refused: approval ${approvalId} named no packet, so there is nothing to file`,
    );
    this.name = 'ApprovalNamesNoPacketError';
  }
}

/**
 * The gate itself refused (invariant 1).
 *
 * `app.require_approval('submit')` is a trigger, not a check in TypeScript, and
 * it is the last word. Its own words are kept inside the message: never
 * swallowed, never reworded into something softer.
 */
export class ApprovalGateRefusedError extends CaseWorkflowError {
  constructor(readonly detail: string) {
    super(`submit refused by the approval gate: ${detail}`);
    this.name = 'ApprovalGateRefusedError';
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * A bigint cents column as a JS number, or a loud failure.
 *
 * Money is integer cents in a bigint (invariant 3), and a JS number holds only
 * 2^53 of them exactly. Every conversion is a place where a value can quietly
 * stop being itself, and a rounded cent on a money path is only ever found in a
 * reconciliation. This refuses instead.
 */
export function exactCents(text: string, column: string): number {
  const cents = Number(text);
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`${column} is ${text}, which no JS number holds exactly`);
  }
  return cents;
}

/** The SQLSTATE of a driver error, when it carries one. */
function sqlState(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function errorText(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : '';
}

function constraintName(error: unknown): string | undefined {
  const constraint = (error as { constraint?: unknown } | null)?.constraint;
  return typeof constraint === 'string' ? constraint : undefined;
}

/**
 * Runs a statement that the database may refuse, and hands the refusal to a
 * translator.
 *
 * The savepoint is what makes that possible at all: a failed statement aborts
 * the whole transaction, and the lookup that explains the failure ("which
 * submission already exists?") is itself a statement. This is the same shape
 * `openCase` uses for its duplicate-claim explanation.
 */
async function translating<T>(
  client: PoolClient,
  name: string,
  work: () => Promise<T>,
  translate: (error: unknown) => Promise<unknown>,
): Promise<T> {
  await client.query(`savepoint ${name}`);
  try {
    const result = await work();
    await client.query(`release savepoint ${name}`);
    return result;
  } catch (error) {
    await client.query(`rollback to savepoint ${name}`);
    throw await translate(error);
  }
}

/** A date column as `YYYY-MM-DD`, whatever the driver handed back. */
function isoDate(value: Date | string | null): string | undefined {
  if (value === null) return undefined;
  if (typeof value === 'string') return value;
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** The case, as every method here needs it. */
interface LockedCase {
  readonly deductionId: string;
  readonly state: CaseState;
  readonly claimId: string | undefined;
  /** The column's own text. Never `Number()`ed on the way into a record. */
  readonly amountText: string;
  readonly deductionDate: string | undefined;
  readonly disputeDeadline: string | undefined;
  /** The matched debtor's name if there is one, else the name as printed. */
  readonly retailer: string | undefined;
}

interface CaseRow {
  id: string;
  state: CaseState;
  claim_id: string | null;
  amount: string;
  deduction_date: Date | string | null;
  dispute_deadline: Date | string | null;
  retailer: string | null;
}

/**
 * Reads the case and holds it until commit.
 *
 * `for update of d` does two jobs. It serialises the check-then-write in every
 * method below, so two people pressing approve at the same moment do not both
 * read `awaiting_approval`. And it makes Postgres apply the UPDATE policy as
 * well as the read one — `tenant_update` is gated on `app.member_may_write()`
 * (migration 0010) — so a `read_only` member gets no row at all, which is how
 * the role refusal below is reached without a second membership query.
 *
 * Both refusals arrive as an empty result and must not be reported as the same
 * thing: telling a `read_only` member that their own case does not exist sends
 * them looking for the wrong problem, and telling another tenant that it does
 * exist tells them something that is none of their business. One extra read, on
 * the failure path only, says which.
 */
async function lockCase(
  client: PoolClient,
  deductionId: string,
  action: string,
  actorId: string,
  roles: readonly string[],
): Promise<LockedCase> {
  const { rows } = await client.query<CaseRow>(
    `select d.id, d.state, d.claim_id, d.deduction_amount_cents::text as amount,
            d.deduction_date, d.dispute_deadline,
            coalesce((select b.display_name from debtors b where b.id = d.debtor_id),
                     d.retailer_name_as_printed) as retailer
       from deductions d
      where d.id = $1
      for update of d`,
    [deductionId],
  );
  const row = rows[0];
  if (row === undefined) {
    const { rows: readable } = await client.query<{ one: number }>(
      `select 1 as one from deductions where id = $1`,
      [deductionId],
    );
    if (readable.length > 0) throw new WrongRoleError(actorId, action, roles);
    // A named refusal, not a bare `Error`: a route renders a case this tenant
    // may not see as a 404, and an unclassified throw as a 500.
    throw new CaseNotVisibleError(deductionId);
  }
  return {
    deductionId: row.id,
    state: row.state,
    claimId: row.claim_id ?? undefined,
    amountText: row.amount,
    deductionDate: isoDate(row.deduction_date),
    disputeDeadline: isoDate(row.dispute_deadline),
    retailer: row.retailer ?? undefined,
  };
}

/**
 * Refuses a method that names somebody other than the person whose session
 * this is.
 *
 * The store is constructed per request and carries the caller, so a method
 * naming a different actor is either a bug or a forgery — and on a money path
 * the two look identical from here. The database enforces exactly this for a
 * human decision (`app.human_decision_names_its_author()`, ADR 0020 §1) and for
 * an approval (`app.approval_names_its_approver()`, ADR 0041); the other acts
 * have no trigger of their own, and letting them name anyone would put an
 * approver's id in an analyst's write.
 */
function requireCaller(actorId: string, callerId: string, action: string): void {
  if (actorId !== callerId) {
    throw new ActorIsNotTheSessionError(actorId, callerId, action);
  }
}

/** The case's own state, hashed, as what the human was looking at when they decided. */
function inputStateHash(from: LockedCase, documentIds: readonly string[]): Buffer {
  const canonical = JSON.stringify({
    amountCents: from.amountText,
    claimId: from.claimId ?? null,
    deductionDate: from.deductionDate ?? null,
    deductionId: from.deductionId,
    disputeDeadline: from.disputeDeadline ?? null,
    documentIds: [...documentIds].sort(),
    retailer: from.retailer ?? null,
  });
  return createHash('sha256').update(canonical, 'utf8').digest();
}

/** Appends to the case's timeline. The hash chain is the trigger's job. */
async function appendEvent(
  client: PoolClient,
  tenant: TenantContext,
  deductionId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into deduction_events
       (org_id, deduction_id, event_type, payload, event_time, created_by)
     values ($1, $2, $3, $4::jsonb, now(), $5)
     returning id::text as id`,
    [tenant.orgId, deductionId, eventType, JSON.stringify(payload), tenant.userId],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`insert into deduction_events (${eventType}) wrote no row`);
  return id;
}

/** The mutable projection of the event stream (plan §6). */
async function setState(
  client: PoolClient,
  deductionId: string,
  to: CaseState,
): Promise<void> {
  const { rowCount } = await client.query(
    `update deductions set state = $2, updated_at = now() where id = $1`,
    [deductionId, to],
  );
  if (rowCount !== 1) {
    throw new Error(`case ${deductionId} did not move to ${to}: ${rowCount ?? 0} rows updated`);
  }
}

/** The documents a packet encloses: the notice first, then the evidence. */
async function packetDocuments(
  client: PoolClient,
  deductionId: string,
): Promise<{ ids: string[]; lines: PacketDocument[] }> {
  const { rows } = await client.query<{ document_id: string; role: string; filename: string }>(
    `select dd.document_id, dd.role, coalesce(d.filename, '') as filename
       from deduction_documents dd
       join documents d on d.id = dd.document_id
      where dd.deduction_id = $1 and dd.role in ('notice', 'evidence')
      order by (dd.role <> 'notice'), dd.id asc`,
    [deductionId],
  );
  return {
    ids: rows.map((row) => row.document_id),
    lines: rows.map((row) => ({
      role: row.role as PacketDocument['role'],
      filename: row.filename,
    })),
  };
}

/**
 * Builds the cover narrative, turning `core-domain`'s own refusal into one of
 * the workflow's.
 *
 * `buildPacketNarrative` raises `PacketError`, which is not a
 * `CaseWorkflowError`: it belongs to a module that knows about cents and
 * templates and nothing about cases, callers or routes. Out raw it would reach
 * a route as an unclassified throw and be rendered as a fault, when it is in
 * fact a refusal a person can act on — usually the rationale, which
 * `recordHumanDecision` caps first so this is the residue: an unbounded claim
 * id, a debtor display name nobody limited, or more documents than the budget
 * allows. Nothing is swallowed: the original is the `cause` and its words are
 * in the message.
 */
function buildNarrativeOrRefuse(
  deductionId: string,
  decisionId: string,
  build: () => string,
): string {
  try {
    return build();
  } catch (error) {
    if (error instanceof PacketError) {
      throw new PacketNotBuildableError(deductionId, decisionId, error.message, { cause: error });
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 1. A human decides
// ---------------------------------------------------------------------------

export async function recordHumanDecision(
  client: PoolClient,
  tenant: TenantContext,
  input: {
    readonly deductionId: string;
    readonly preparedBy: string;
    readonly reason: CanonicalReasonCode;
    readonly rationale: string;
  },
): Promise<{ readonly decisionId: string }> {
  requireCaller(input.preparedBy, tenant.userId, 'decide');
  const existing = await lockCase(
    client,
    input.deductionId,
    'decide',
    input.preparedBy,
    WRITER_ROLES,
  );

  // A case we already chose not to fight is not a case to dispute. The lock
  // above is what makes this read and the insert below one decision, the same
  // way `declineCase` does it from the other side.
  const { rows: declined } = await client.query<{ id: string }>(
    `select id from declined_candidates where deduction_id = $1 order by decided_at asc limit 1`,
    [input.deductionId],
  );
  const standing = declined[0];
  if (standing !== undefined) {
    throw new CaseAlreadyDeclinedError(input.deductionId, standing.id);
  }

  if (existing.state !== 'classified') {
    throw new WrongCaseStateError(input.deductionId, 'decide', existing.state, ['classified']);
  }
  const rationale = input.rationale.trim();
  if (rationale === '') {
    throw new RationaleRequiredError(input.deductionId);
  }
  // Before the insert, which is the only moment this can still be asked.
  // `decisions` is append-only and the packet is assembled later, so a rationale
  // that only `packets.narrative` would refuse gets the case to
  // `analyst_review` and then wedges it: the decision cannot be amended and no
  // packet can ever be built from it. The cap is `MAX_NARRATIVE_LENGTH` minus
  // what the rest of the cover page spends (core-domain/src/packet.ts).
  if (rationale.length > MAX_RATIONALE_LENGTH) {
    throw new RationaleTooLongError(input.deductionId, rationale.length, MAX_RATIONALE_LENGTH);
  }
  // The type says this is canonical; a form post is a string until something
  // checks. A reason nothing can map to a family is a decision Phase 5 cannot
  // count and a packet that names a code no playbook has.
  if (!isCanonicalReasonCode(input.reason)) {
    throw new NotACanonicalReasonError(input.deductionId, input.reason);
  }
  // The table is the spec, and naming the trigger is what makes the move a
  // function of the fact that caused it (ADR 0020 §4).
  applyTransition('classified', 'analyst_review', 'decision.recorded', {
    human_decision_recorded: true,
  });

  const { ids } = await packetDocuments(client, input.deductionId);
  const decisionId = await translating(
    client,
    'before_human_decision',
    async () => {
      const { rows } = await client.query<{ id: string }>(
        `insert into decisions
           (org_id, deduction_id, schema_id, schema_version, provider, model_version,
            input_state_hash, questions, result, raw_probabilities, confidence,
            latency_ms, cost_micros, prepared_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, '{}'::jsonb,
                 1.0000, 0, 0, $10)
         returning id`,
        [
          tenant.orgId,
          input.deductionId,
          HUMAN_SCHEMA_ID,
          HUMAN_SCHEMA_VERSION,
          HUMAN_PROVIDER,
          HUMAN_MODEL_VERSION,
          inputStateHash(existing, ids),
          // The form: what the analyst was asked.
          JSON.stringify({ dispute_reason: 'choice', rationale: 'text' }),
          // Their answers, in the shape a Schema B answer has, so Phase 2 can
          // score a model against what humans decided.
          JSON.stringify({ dispute_reason: input.reason, rationale }),
          input.preparedBy,
        ],
      );
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('insert into decisions returned no row');
      return id;
    },
    async (error) => {
      // `app.human_decision_names_its_author()`: a human decision is written by
      // the person it names, in their own session. `requireCaller` above should
      // have caught this already; if it did not, the database is the referee and
      // its refusal is reported rather than swallowed.
      // 23001 is `restrict_violation`, which is what every guard trigger in
      // this schema raises with.
      // The substring is pinned by supabase/tests/11_a_human_decides.sql:75 and
      // :85 ("is not the caller"), which is what keeps this match and the
      // trigger's wording from drifting apart.
      if (sqlState(error) === '23001' && /is not the caller/.test(errorText(error))) {
        return new HumanDecisionAuthorError(errorText(error));
      }
      if (/decisions_human_names_its_preparer/.test(errorText(error))) {
        return new HumanDecisionAuthorError(
          'a human decision must name the analyst who prepared it',
        );
      }
      return error;
    },
  );

  await appendEvent(client, tenant, input.deductionId, 'decision.recorded', {
    decision_id: decisionId,
    provider: HUMAN_PROVIDER,
    schema_id: HUMAN_SCHEMA_ID,
    schema_version: HUMAN_SCHEMA_VERSION,
    reason: input.reason,
    rationale,
    prepared_by: input.preparedBy,
  });
  await setState(client, input.deductionId, 'analyst_review');
  return { decisionId };
}

// ---------------------------------------------------------------------------
// 2. The packet
// ---------------------------------------------------------------------------

export async function assemblePacket(
  client: PoolClient,
  tenant: TenantContext,
  input: {
    readonly deductionId: string;
    readonly decisionId: string;
    readonly assembledBy: string;
  },
): Promise<{
  readonly packetId: string;
  readonly contentHash: string;
  readonly narrative: string;
  readonly fileDocumentIds: readonly string[];
}> {
  requireCaller(input.assembledBy, tenant.userId, 'assemble');
  const existing = await lockCase(
    client,
    input.deductionId,
    'assemble',
    input.assembledBy,
    WRITER_ROLES,
  );

  const decision = await readHumanDecision(client, input.decisionId);
  if (decision === undefined || decision.deductionId !== input.deductionId) {
    throw new DecisionNotForCaseError(input.decisionId, input.deductionId);
  }

  const { ids, lines } = await packetDocuments(client, input.deductionId);
  if (ids.length === 0) {
    throw new NothingToSendError(input.deductionId);
  }

  const narrative = buildNarrativeOrRefuse(input.deductionId, input.decisionId, () =>
    buildPacketNarrative({
      ...(existing.claimId !== undefined ? { claimId: existing.claimId } : {}),
      ...(existing.retailer !== undefined ? { retailer: existing.retailer } : {}),
      deductionAmountCents: exactCents(existing.amountText, 'deduction_amount_cents'),
      ...(existing.deductionDate !== undefined
        ? { deductionDate: existing.deductionDate }
        : {}),
      ...(existing.disputeDeadline !== undefined
        ? { disputeDeadline: existing.disputeDeadline }
        : {}),
      reason: decision.reason,
      rationale: decision.rationale,
      documents: lines,
    }),
  );
  const contentHash = packetContentHash({
    decisionId: input.decisionId,
    narrative,
    fileDocumentIds: ids,
  });

  // Identical contents are one packet — `unique (decision_id, content_hash)`
  // says so, and this is the read that keeps the constraint from ever being
  // reached by a double-clicked button. It comes before the state check because
  // re-assembling is not a second assembly: a case already waiting for approval
  // must be handed back its packet, not told it is in the wrong state.
  const already = await readPacketBy(client, 'decision', input.decisionId, contentHash);
  if (already !== undefined) {
    return {
      packetId: already.packetId,
      contentHash: already.contentHash,
      narrative: already.narrative,
      fileDocumentIds: already.fileDocumentIds,
    };
  }

  // A packet with *different* contents for the same decision is a second row,
  // not a conflict — that is the other half of `unique (decision_id,
  // content_hash)`, and it is what happens when the reviewer attaches another
  // document and assembles again. So there are two ways in: the case is in
  // `analyst_review` and this move carries it across the edge, or it is already
  // waiting and nothing moves.
  //
  // Not once it has been approved, though. `unique (decision_id, action_type)`
  // means there is no second approval, so a packet assembled after one would be
  // a packet nobody can ever authorise, sitting next to an approval that names
  // the packet it replaced. Refused, rather than left for the hash check to
  // turn into a puzzling mismatch at submission time.
  const alreadyApproved =
    existing.state === 'awaiting_approval'
      ? await readApproval(client, input.decisionId)
      : undefined;
  if (alreadyApproved !== undefined) {
    throw new PacketAfterApprovalError(input.decisionId, alreadyApproved.packetHash);
  }
  if (existing.state === 'analyst_review') {
    applyTransition('analyst_review', 'awaiting_approval', 'packet.assembled', {
      packet_assembled_and_submission_safe: true,
    });
  } else if (existing.state !== 'awaiting_approval') {
    throw new WrongCaseStateError(input.deductionId, 'assemble', existing.state, [
      'analyst_review',
      'awaiting_approval',
    ]);
  }

  const { rows } = await client.query<{ id: string }>(
    `insert into packets
       (org_id, deduction_id, decision_id, content_hash, narrative, file_document_ids,
        assembled_by)
     values ($1, $2, $3, $4, $5, $6::uuid[], $7)
     returning id`,
    [
      tenant.orgId,
      input.deductionId,
      input.decisionId,
      Buffer.from(contentHash, 'hex'),
      narrative,
      ids,
      input.assembledBy,
    ],
  );
  const packetId = rows[0]?.id;
  if (packetId === undefined) throw new Error('insert into packets returned no row');

  await appendEvent(client, tenant, input.deductionId, 'packet.assembled', {
    packet_id: packetId,
    decision_id: input.decisionId,
    content_hash: contentHash,
    file_document_ids: ids,
    assembled_by: input.assembledBy,
  });
  if (existing.state === 'analyst_review') {
    await setState(client, input.deductionId, 'awaiting_approval');
  }
  return { packetId, contentHash, narrative, fileDocumentIds: ids };
}

// ---------------------------------------------------------------------------
// 3. A second human approves
// ---------------------------------------------------------------------------

export async function approve(
  client: PoolClient,
  tenant: TenantContext,
  input: {
    readonly decisionId: string;
    readonly packetId: string;
    readonly approverId: string;
    readonly note?: string;
  },
): Promise<{ readonly approvalId: string; readonly deductionId: string }> {
  requireCaller(input.approverId, tenant.userId, 'approve');
  const packet = await readPacketBy(client, 'id', input.packetId);
  if (packet === undefined || packet.decisionId !== input.decisionId) {
    throw new PacketNotForDecisionError(input.packetId, input.decisionId, 'approve');
  }
  const existing = await lockCase(
    client,
    packet.deductionId,
    'approve',
    input.approverId,
    APPROVER_ROLES,
  );
  if (existing.state !== 'awaiting_approval') {
    throw new WrongCaseStateError(packet.deductionId, 'approve', existing.state, [
      'awaiting_approval',
    ]);
  }

  const approvalId = await translating(
    client,
    'before_approval',
    async () => {
      const { rows } = await client.query<{ id: string }>(
        `insert into approvals (org_id, decision_id, approver_id, action_type, note, packet_hash)
         values ($1, $2, $3, 'submit', $4, $5)
         returning id`,
        [
          tenant.orgId,
          input.decisionId,
          input.approverId,
          input.note ?? null,
          Buffer.from(packet.contentHash, 'hex'),
        ],
      );
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('insert into approvals returned no row');
      return id;
    },
    async (error) => {
      const text = errorText(error);
      // Separation of duties, in the database's own words (migration 0005).
      // Each of these is a rule a reviewer will meet, so each gets a name —
      // matched on the trigger's own errcode as well as its message, so a
      // sentence that happens to contain these words cannot be mistaken for
      // the trigger, and a refusal this does not recognise reaches the caller
      // as itself rather than as the nearest rule.
      const refused = sqlState(error) === '23001';
      // `app.approval_names_its_approver()` (migration 0031, ADR 0041): an
      // approval is written by the person it names, in their own session.
      // `requireCaller` above should have caught this already; if it did not,
      // the database is the referee and its words are carried rather than
      // replaced. Neither SoD message contains this substring, so the two
      // matches below are unaffected by it. Pinned by
      // supabase/tests/27_an_approval_is_written_by_its_approver.sql:42.
      if (refused && /is not the caller/.test(text)) {
        return new ApprovalAuthorError(text);
      }
      // Pinned by supabase/tests/11_a_human_decides.sql:205 and
      // supabase/tests/03_separation_of_duties.sql:21.
      if (refused && /cannot approve their own decision/.test(text)) {
        return new PreparerCannotApproveError(input.decisionId, input.approverId);
      }
      // Pinned by supabase/tests/11_a_human_decides.sql:217 and, as the shorter
      // "is not an approver", supabase/tests/03_separation_of_duties.sql:31.
      if (refused && /is not an approver in org/.test(text)) {
        return new WrongRoleError(input.approverId, 'approve', APPROVER_ROLES);
      }
      if (sqlState(error) === '23505') {
        const { rows } = await client.query<{ id: string }>(
          `select id from approvals where decision_id = $1 and action_type = 'submit'`,
          [input.decisionId],
        );
        return new DuplicateApprovalError(input.decisionId, rows[0]?.id ?? 'unknown');
      }
      if (constraintName(error) === 'approvals_packet_is_a_real_packet') {
        return new ApprovedPacketMissingError(input.decisionId);
      }
      // Pinned by supabase/tests/11_a_human_decides.sql:186 ("does not exist")
      // and :406 ("belongs to another org").
      if (refused && /decision .* (does not exist|belongs to another org)/.test(text)) {
        return new DecisionNotFoundError(input.decisionId, 'approve', text);
      }
      return error;
    },
  );

  // No state change: approving is what lets the case leave `awaiting_approval`,
  // and recording the submission is what moves it. This is the
  // `approval.granted` the submit workflow waits for (state-machine.ts).
  await appendEvent(client, tenant, packet.deductionId, 'approval.granted', {
    approval_id: approvalId,
    decision_id: input.decisionId,
    action_type: 'submit',
    packet_hash: packet.contentHash,
    approver_id: input.approverId,
  });
  // The case this landed on, which the caller never named: the decision and the
  // packet came off a form, and the case is the packet's. A caller that has to
  // read it back has to trust a second query to tell it where its own write
  // went (ADR 0020 §6, `CaseWorkflowStore.approve`).
  return { approvalId, deductionId: packet.deductionId };
}

// ---------------------------------------------------------------------------
// 4. Somebody files it
// ---------------------------------------------------------------------------

export async function recordSubmission(
  client: PoolClient,
  tenant: TenantContext,
  input: {
    readonly decisionId: string;
    readonly packetId: string;
    readonly approvalId: string;
    readonly channel: WorkflowSubmissionChannel;
    readonly confirmationNumber: string;
    readonly submittedAt: Date;
    readonly actorId: string;
  },
): Promise<{ readonly submissionId: string; readonly deductionId: string }> {
  requireCaller(input.actorId, tenant.userId, 'submit');
  const packet = await readPacketBy(client, 'id', input.packetId);
  if (packet === undefined || packet.decisionId !== input.decisionId) {
    throw new PacketNotForDecisionError(input.packetId, input.decisionId, 'submit');
  }
  const { rows: approvalRows } = await client.query<{
    id: string;
    decision_id: string;
    packet_hash: Buffer | null;
  }>(
    `select id, decision_id, packet_hash from approvals
      where id = $1 and action_type = 'submit'`,
    [input.approvalId],
  );
  const approval = approvalRows[0];
  if (approval === undefined || approval.decision_id !== input.decisionId) {
    // The gate says this too, and says it last: `app.require_approval('submit')`
    // refuses the insert whatever this store believes (migration 0005).
    throw new NoApprovalForSubmissionError(input.decisionId);
  }
  if (approval.packet_hash === null) {
    // The foreign key is `MATCH SIMPLE`, so the database accepts a `submit`
    // approval naming no packet (ADR 0020 §5). Refusing to file against one is
    // this store's job, not the gate's.
    throw new ApprovalNamesNoPacketError(input.approvalId);
  }

  const existing = await lockCase(
    client,
    packet.deductionId,
    'submit',
    input.actorId,
    WRITER_ROLES,
  );
  // Asked before the state check, because a case that has been submitted is no
  // longer `awaiting_approval` and a double-clicked submit button would
  // otherwise be told it was in the wrong state — true, and useless. The unique
  // constraint below is still what makes this safe under a race; this is what
  // makes the answer say what happened.
  const duplicate = await readSubmission(client, input.decisionId, input.channel);
  if (duplicate !== undefined) {
    throw new DuplicateSubmissionError(input.decisionId, input.channel, duplicate.submissionId);
  }
  if (existing.state !== 'awaiting_approval') {
    throw new WrongCaseStateError(packet.deductionId, 'submit', existing.state, [
      'awaiting_approval',
    ]);
  }

  // The store's half of the rule, and the reason the trigger does not carry it:
  // the gate answers "was this decision approved", and this answers "is this
  // the packet that was approved" (ADR 0020 §2). The database deliberately
  // permits the mismatch, and `11_a_human_decides.sql` asserts that it does.
  const approvedHash = approval.packet_hash.toString('hex');
  if (approvedHash !== packet.contentHash) {
    throw new PacketHashMismatchError(input.decisionId, approvedHash, packet.contentHash);
  }
  // Trimmed once, here, and it is the trimmed value that is both stored and put
  // on the event: a confirmation number that differs from the portal's by a
  // trailing space is one nobody can match back to the retailer's record, and
  // a row and an event that disagree about it are two answers to one question.
  const confirmationNumber = input.confirmationNumber.trim();
  if (confirmationNumber === '') {
    throw new ConfirmationNumberRequiredError(input.decisionId);
  }
  applyTransition('awaiting_approval', 'submitted', 'submission.recorded', {
    approval_row_exists: true,
  });

  const submissionId = await translating(
    client,
    'before_submission',
    async () => {
      const { rows } = await client.query<{ id: string }>(
        `insert into submissions
           (org_id, deduction_id, decision_id, channel, status, packet_hash,
            confirmation_number, submitted_at)
         values ($1, $2, $3, $4, 'recorded', $5, $6, $7)
         returning id`,
        [
          tenant.orgId,
          packet.deductionId,
          input.decisionId,
          input.channel,
          Buffer.from(packet.contentHash, 'hex'),
          confirmationNumber,
          input.submittedAt,
        ],
      );
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('insert into submissions returned no row');
      return id;
    },
    async (error) => {
      if (sqlState(error) === '23505') {
        const { rows } = await client.query<{ id: string }>(
          `select id from submissions where decision_id = $1 and channel = $2`,
          [input.decisionId, input.channel],
        );
        return new DuplicateSubmissionError(
          input.decisionId,
          input.channel,
          rows[0]?.id ?? 'unknown',
        );
      }
      // The gate. Never swallowed, never reworded into something softer — and
      // it keeps the trigger's own words inside the message it raises.
      // Pinned by supabase/tests/11_a_human_decides.sql:195 and, for the
      // model-decided path, supabase/tests/02_approval_invariant.sql:18.
      if (sqlState(error) === '23001' && /no submit approval row/.test(errorText(error))) {
        return new ApprovalGateRefusedError(errorText(error));
      }
      return error;
    },
  );

  await appendEvent(client, tenant, packet.deductionId, 'submission.recorded', {
    submission_id: submissionId,
    decision_id: input.decisionId,
    channel: input.channel,
    packet_hash: packet.contentHash,
    confirmation_number: confirmationNumber,
    submitted_at: input.submittedAt.toISOString(),
    recorded_by: input.actorId,
  });
  await setState(client, packet.deductionId, 'submitted');
  // The case the filing was recorded against, for the same reason `approve`
  // answers with one: it is the packet's case, not a case the caller named.
  return { submissionId, deductionId: packet.deductionId };
}

// ---------------------------------------------------------------------------
// 5. What came back
// ---------------------------------------------------------------------------

/**
 * What a recovery may be, given what came back.
 *
 * `won` means the whole deduction came back. A dispute that recovered less than
 * the deduction is `partial`, however the retailer described it — otherwise
 * "won" would mean two different amounts, and Phase 4's contingency billing
 * would be summing a word rather than a number. `lost` recovered nothing.
 *
 * The comparison is `BigInt` against the column's own text, because the
 * deduction is a bigint and `Number()` on one stops being exact above 2^53
 * (invariant 3). The offered cents are checked into the safe-integer range
 * first, so the conversion that follows cannot be the lossy one.
 *
 * `@recouple/pipeline/testing` states the same rule against a JS number, which
 * is what that store holds. A shared helper would have to take one of the two
 * representations and convert the other into it, and that conversion is the
 * one invariant 3 exists to avoid; what keeps the two saying the same thing is
 * the contract suite, which runs the same cases against both.
 */
function checkRecoveredCents(
  deductionId: string,
  outcome: CaseOutcome,
  recoveredCents: number,
  amountText: string,
): void {
  const refuse = (reason: string): never => {
    throw new InvalidRecoveryAmountError(deductionId, outcome, recoveredCents, reason);
  };
  if (!Number.isInteger(recoveredCents)) refuse('cents are integers (invariant 3)');
  if (!Number.isSafeInteger(recoveredCents)) refuse('no JS number holds that many cents exactly');
  if (recoveredCents < 0) refuse('a recovery cannot be negative');

  const recovered = BigInt(recoveredCents);
  const deduction = BigInt(amountText);
  if (outcome === 'lost' && recovered !== 0n) refuse('a lost case recovered nothing');
  if (outcome === 'won' && recovered !== deduction) {
    refuse(
      `a won case recovered the whole deduction of ${amountText} cents; anything less is partial`,
    );
  }
  if (outcome === 'partial' && (recovered <= 0n || recovered >= deduction)) {
    refuse(
      `a partial recovery is strictly between nothing and the whole deduction of ` +
        `${amountText} cents`,
    );
  }
}

export async function recordOutcome(
  client: PoolClient,
  tenant: TenantContext,
  input: {
    readonly deductionId: string;
    readonly outcome: CaseOutcome;
    readonly recoveredCents: number;
    readonly recordedBy: string;
    readonly note?: string;
  },
): Promise<{ readonly eventId: string }> {
  requireCaller(input.recordedBy, tenant.userId, 'record outcome');
  const existing = await lockCase(
    client,
    input.deductionId,
    'record outcome',
    input.recordedBy,
    WRITER_ROLES,
  );
  // A second outcome is refused by the case no longer being `submitted`, which
  // is the same thing that refuses an outcome on a case nobody ever filed.
  if (existing.state !== 'submitted') {
    throw new WrongCaseStateError(input.deductionId, 'record outcome', existing.state, [
      'submitted',
    ]);
  }
  checkRecoveredCents(input.deductionId, input.outcome, input.recoveredCents, existing.amountText);
  applyTransition('submitted', input.outcome, 'outcome.recorded', {
    outcome_recorded_by_human: true,
  });

  const eventId = await appendEvent(client, tenant, input.deductionId, 'outcome.recorded', {
    outcome: input.outcome,
    // The digits, as text. jsonb would hold a number of any size, but
    // everything that reads a payload back goes through `JSON.parse`, and that
    // is where a bigint rounds — the same treatment `case.declined` gives its
    // cents.
    recovered_cents: String(input.recoveredCents),
    recorded_by: input.recordedBy,
    ...(input.note !== undefined ? { note: input.note } : {}),
  });
  await setState(client, input.deductionId, input.outcome);
  return { eventId };
}

// ---------------------------------------------------------------------------
// The read behind the case page
// ---------------------------------------------------------------------------

interface DecisionRow {
  id: string;
  deduction_id: string;
  result: { dispute_reason?: unknown; rationale?: unknown } | null;
  prepared_by: string | null;
  created_at: Date | string;
}

function toDecision(row: DecisionRow): HumanDecisionRecord {
  const reason = row.result?.dispute_reason;
  const rationale = row.result?.rationale;
  return {
    decisionId: row.id,
    deductionId: row.deduction_id,
    reason: (typeof reason === 'string' ? reason : 'unknown_uncoded') as CanonicalReasonCode,
    rationale: typeof rationale === 'string' ? rationale : '',
    // `decisions_human_names_its_preparer` makes this not-null for a human row,
    // so an empty string here would be a row the database cannot hold.
    preparedBy: row.prepared_by ?? '',
    decidedAt: new Date(row.created_at),
  };
}

async function readHumanDecision(
  client: PoolClient,
  decisionId: string,
): Promise<HumanDecisionRecord | undefined> {
  const { rows } = await client.query<DecisionRow>(
    `select id, deduction_id, result, prepared_by, created_at
       from decisions where id = $1 and provider = $2`,
    [decisionId, HUMAN_PROVIDER],
  );
  const row = rows[0];
  return row === undefined ? undefined : toDecision(row);
}

interface PacketRow {
  id: string;
  deduction_id: string;
  decision_id: string;
  content_hash: Buffer;
  narrative: string;
  file_document_ids: string[];
  assembled_by: string;
  created_at: Date | string;
}

function toPacket(row: PacketRow): PacketRecord & { readonly deductionId: string } {
  return {
    packetId: row.id,
    deductionId: row.deduction_id,
    decisionId: row.decision_id,
    contentHash: row.content_hash.toString('hex'),
    narrative: row.narrative,
    fileDocumentIds: row.file_document_ids,
    assembledBy: row.assembled_by,
    assembledAt: new Date(row.created_at),
  };
}

/**
 * One packet, by its id or by the contents it was assembled under.
 *
 * There is no `org_id` predicate, here or anywhere else in this file: the
 * policies decide, and another tenant's packet comes back as nothing rather
 * than as a row somebody then has to remember to check.
 */
async function readPacketBy(
  client: PoolClient,
  by: 'id' | 'decision',
  key: string,
  contentHash?: string,
): Promise<(PacketRecord & { readonly deductionId: string }) | undefined> {
  const columns = `id, deduction_id, decision_id, content_hash, narrative,
                   file_document_ids, assembled_by, created_at`;
  const { rows } =
    by === 'id'
      ? await client.query<PacketRow>(`select ${columns} from packets where id = $1`, [key])
      : await client.query<PacketRow>(
          `select ${columns} from packets where decision_id = $1 and content_hash = $2`,
          [key, Buffer.from(contentHash ?? '', 'hex')],
        );
  const row = rows[0];
  return row === undefined ? undefined : toPacket(row);
}

/**
 * The submit approval for a decision, if a human has granted one.
 *
 * `unique (decision_id, action_type)` means there is at most one. An approval
 * whose `packet_hash` is null is not one of ours — that column is nullable for
 * `writeoff` and `writeback`, which have no packet (ADR 0020 §2) — so it is
 * reported as no approval rather than as one naming nothing.
 */
async function readApproval(
  client: PoolClient,
  decisionId: string,
): Promise<ApprovalRecord | undefined> {
  const { rows } = await client.query<{
    id: string;
    decision_id: string;
    approver_id: string;
    packet_hash: Buffer | null;
    note: string | null;
    approved_at: Date | string;
  }>(
    `select id, decision_id, approver_id, packet_hash, note, approved_at
       from approvals where decision_id = $1 and action_type = 'submit'`,
    [decisionId],
  );
  const row = rows[0];
  if (row === undefined || row.packet_hash === null) return undefined;
  return {
    approvalId: row.id,
    decisionId: row.decision_id,
    approverId: row.approver_id,
    packetHash: row.packet_hash.toString('hex'),
    ...(row.note !== null ? { note: row.note } : {}),
    approvedAt: new Date(row.approved_at),
  };
}

/** The submission for a decision on a channel, if one has been recorded. */
async function readSubmission(
  client: PoolClient,
  decisionId: string,
  channel?: string,
): Promise<SubmissionRecord | undefined> {
  const { rows } =
    channel === undefined
      ? await client.query<SubmissionRow>(
          `select id, decision_id, channel, packet_hash, confirmation_number, submitted_at
             from submissions where decision_id = $1 order by created_at asc limit 1`,
          [decisionId],
        )
      : await client.query<SubmissionRow>(
          `select id, decision_id, channel, packet_hash, confirmation_number, submitted_at
             from submissions where decision_id = $1 and channel = $2`,
          [decisionId, channel],
        );
  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    submissionId: row.id,
    decisionId: row.decision_id,
    channel: row.channel as WorkflowSubmissionChannel,
    packetHash: row.packet_hash?.toString('hex') ?? '',
    confirmationNumber: row.confirmation_number ?? '',
    submittedAt: new Date(row.submitted_at ?? 0),
  };
}

interface SubmissionRow {
  id: string;
  decision_id: string;
  channel: string;
  packet_hash: Buffer | null;
  confirmation_number: string | null;
  submitted_at: Date | string | null;
}

export async function getWorkflow(
  client: PoolClient,
  deductionId: string,
): Promise<CaseWorkflow | undefined> {
  const { rows: caseRows } = await client.query<{ id: string; state: CaseState }>(
    `select id, state from deductions where id = $1`,
    [deductionId],
  );
  const found = caseRows[0];
  if (found === undefined) return undefined;

  const { rows: decisionRows } = await client.query<DecisionRow>(
    `select id, deduction_id, result, prepared_by, created_at
       from decisions
      where deduction_id = $1 and provider = $2
      order by created_at desc, id desc
      limit 1`,
    [deductionId, HUMAN_PROVIDER],
  );
  const decisionRow = decisionRows[0];
  if (decisionRow === undefined) return { deductionId, state: found.state };
  const decision = toDecision(decisionRow);

  const approval = await readApproval(client, decision.decisionId);

  // The packet the approval named, when there is one: a case page should show
  // what was approved rather than the most recent thing assembled.
  const packet =
    approval !== undefined
      ? await readPacketBy(client, 'decision', decision.decisionId, approval.packetHash)
      : await latestPacket(client, decision.decisionId);

  const submission = await readSubmission(client, decision.decisionId);

  const { rows: outcomeRows } = await client.query<{
    id: string;
    payload: Record<string, unknown>;
    event_time: Date | string;
  }>(
    `select id::text as id, payload, event_time
       from deduction_events
      where deduction_id = $1 and event_type = 'outcome.recorded'
      order by id desc limit 1`,
    [deductionId],
  );
  const outcomeRow = outcomeRows[0];
  const outcome: OutcomeRecord | undefined =
    outcomeRow === undefined
      ? undefined
      : {
          eventId: outcomeRow.id,
          deductionId,
          outcome: outcomeRow.payload.outcome as CaseOutcome,
          // Written as digits, read back as digits (invariant 3).
          recoveredCents: exactCents(String(outcomeRow.payload.recovered_cents), 'recovered_cents'),
          recordedBy: String(outcomeRow.payload.recorded_by ?? ''),
          ...(typeof outcomeRow.payload.note === 'string'
            ? { note: outcomeRow.payload.note }
            : {}),
          recordedAt: new Date(outcomeRow.event_time),
        };

  return {
    deductionId,
    state: found.state,
    decision,
    ...(packet !== undefined ? { packet } : {}),
    ...(approval !== undefined ? { approval } : {}),
    ...(submission !== undefined ? { submission } : {}),
    ...(outcome !== undefined ? { outcome } : {}),
  };
}

// ---------------------------------------------------------------------------
// 6. The pairs identity resolution left for a person (ADR 0032)
// ---------------------------------------------------------------------------
//
// `resolveIdentity` merges only on an exact identifier match; a probable one
// opens the case anyway and records `case.possible_duplicate` naming the other
// deduction (ADR 0025 §6). Until now nothing read those events, so the pair
// stopped nowhere. These two are the human half: the list, and the verdict.
//
// A verdict is two append-only events. "Same deduction" may also merge the pair
// (ADR 0042), which is one `deduction_merges` row: the database checks it, moves
// the merged-away case to `merged` and writes the events, and an undo is a
// second row. No identifier is ever re-pointed — ADR 0032 §5 says why that
// cannot be written at all while `deduction_identifiers` is append-only and
// unique per source.
//
// Which verdict stands on a pair is `duplicate_pair_verdicts`' answer: the
// latest confirmed, dismissed or withdrawn event, where a withdrawal — written
// only by an undone merge — means the pair is open again.

/** The event a probable match leaves behind. */
const PAIR_NAMED = 'case.possible_duplicate';
/** The two a person leaves behind, one of them, on both cases. */
const PAIR_CONFIRMED = 'case.duplicate_confirmed';
const PAIR_DISMISSED = 'case.duplicate_dismissed';

/** Which event a verdict is. One place, so the read and the write agree. */
function eventTypeFor(verdict: DuplicateVerdict): string {
  return verdict === 'same' ? PAIR_CONFIRMED : PAIR_DISMISSED;
}

/**
 * The most pairs one call will answer with, however many it was asked for.
 *
 * A screen, not a database dump — `UNREAD_DOCUMENTS_MAX_LIMIT`'s reason. A
 * tenant with a thousand unanswered pairs has a problem no list can show them.
 */
export const POSSIBLE_DUPLICATES_MAX_LIMIT = 100;

/**
 * An id as the payload spells it.
 *
 * `payload->>'of'` is text and `deductions.id` is a uuid, so the pair is matched
 * as text on both sides rather than by casting the payload — a cast is a
 * statement that fails the whole query on one malformed value, and this read
 * runs over every event a tenant has. Postgres prints a uuid in lower case, so
 * folding an id from a URL is what makes the two comparable.
 */
function idKey(id: string): string {
  return id.trim().toLowerCase();
}

interface CandidateRow {
  state: CaseState;
  claim_id: string | null;
  amount: string;
  deduction_date: Date | string | null;
  created_at: Date | string;
  debtor_name: string | null;
  retailer_name_as_printed: string | null;
  invoice_number: string | null;
}

interface PairRow extends Record<string, unknown> {
  event_id: string;
  event_time: Date | string;
  basis: unknown;
  a_id: string;
  z_id: string;
}

/** One side of a pair, out of the columns the query aliased for it. */
function candidate(deductionId: string, row: CandidateRow): DuplicateCandidateCase {
  const debtorName = row.debtor_name ?? undefined;
  // The debtor when one matched, else the name the document printed, with a
  // flag saying which — the case list's rule (ADR 0019), so a reviewer
  // comparing two cases is never told a printed name is a matched one.
  const retailer = debtorName ?? row.retailer_name_as_printed ?? undefined;
  const deductionDate = isoDate(row.deduction_date);
  return {
    deductionId,
    state: row.state,
    ...(row.claim_id !== null ? { claimId: row.claim_id } : {}),
    ...(row.invoice_number !== null ? { invoiceNumber: row.invoice_number } : {}),
    ...(retailer !== undefined ? { retailer } : {}),
    retailerMatched: debtorName !== undefined,
    // Integer cents, converted once, from the column's own text (invariant 3).
    deductionAmountCents: exactCents(row.amount, 'deduction_amount_cents'),
    ...(deductionDate !== undefined ? { deductionDate } : {}),
    openedAt: new Date(row.created_at).toISOString(),
  };
}

/** The basis as the event recorded it: names of facts, never their values. */
function basisOf(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/**
 * The columns each side of a pair is summarised by, aliased with a prefix.
 *
 * Written once and used twice rather than typed out for `a` and `z` in turn:
 * the two sides of a pair are shown next to each other, and a list where one
 * column means something different on the left than on the right is a list a
 * reviewer compares wrongly.
 */
function sideColumns(alias: string, prefix: string): string {
  return [
    `${alias}.state as ${prefix}_state`,
    `${alias}.claim_id as ${prefix}_claim_id`,
    `${alias}.amount as ${prefix}_amount`,
    `${alias}.deduction_date as ${prefix}_deduction_date`,
    `${alias}.created_at as ${prefix}_created_at`,
    `${alias}.debtor_name as ${prefix}_debtor_name`,
    `${alias}.retailer_name_as_printed as ${prefix}_retailer_name_as_printed`,
    `${alias}.invoice_number as ${prefix}_invoice_number`,
  ].join(',\n                ');
}

/** The prefixed columns of one side, back as the row shape `candidate` reads. */
function sideOf(row: PairRow, prefix: string): CandidateRow {
  return {
    state: row[`${prefix}_state`] as CaseState,
    claim_id: row[`${prefix}_claim_id`] as string | null,
    amount: row[`${prefix}_amount`] as string,
    deduction_date: row[`${prefix}_deduction_date`] as Date | string | null,
    created_at: row[`${prefix}_created_at`] as Date | string,
    debtor_name: row[`${prefix}_debtor_name`] as string | null,
    retailer_name_as_printed: row[`${prefix}_retailer_name_as_printed`] as string | null,
    invoice_number: row[`${prefix}_invoice_number`] as string | null,
  };
}

/** Which of the two was opened first. The one a confirmation says survives. */
function olderFirst(
  left: DuplicateCandidateCase,
  right: DuplicateCandidateCase,
): readonly [DuplicateCandidateCase, DuplicateCandidateCase] {
  if (left.openedAt !== right.openedAt) {
    return left.openedAt < right.openedAt ? [left, right] : [right, left];
  }
  // Two cases opened in one transaction carry the identical `created_at`, which
  // defaults to the transaction's start time. The id is arbitrary but fixed, so
  // the same pair answers the same way every time it is asked rather than
  // changing when the planner does — `declineCase`'s reason for the same tie
  // break.
  return left.deductionId < right.deductionId ? [left, right] : [right, left];
}

export async function possibleDuplicates(
  client: PoolClient,
  options?: { readonly deductionId?: string; readonly limit?: number },
): Promise<readonly PossibleDuplicatePair[]> {
  const limit = options?.limit ?? POSSIBLE_DUPLICATES_MAX_LIMIT;
  // Loud, not coerced. A `NaN` reaches the driver as a bind parameter that
  // answers nothing at all, and "nothing to answer" is the one reply this list
  // must never give wrongly — `unreadDocuments` refuses the same way.
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`possibleDuplicates limit must be a positive integer, got ${String(limit)}`);
  }
  const only = options?.deductionId === undefined ? null : idKey(options.deductionId);

  const { rows } = await client.query<PairRow>(
    `with named as (
       select e.id as event_id,
              e.event_time,
              coalesce(e.payload->'basis', '[]'::jsonb) as basis,
              e.deduction_id::text as side_a,
              lower(e.payload->>'of') as side_b
         from deduction_events e
        where e.event_type = $1
          and e.payload->>'of' is not null
     ),
     answered as (
       -- A verdict standing on the pair. A withdrawn one (ADR 0042 §5) is not.
       select v.low_id, v.high_id
         from duplicate_pair_verdicts v
        where v.verdict is not null
     ),
     merged_away as (
       select c.merged_deduction_id::text as id from deduction_merges_current c
     ),
     summary as (
       select d.id::text as id,
              d.state,
              d.claim_id,
              d.deduction_amount_cents::text as amount,
              d.deduction_date,
              d.created_at,
              b.display_name as debtor_name,
              d.retailer_name_as_printed,
              (select i.identifier from deduction_identifiers i
                where i.deduction_id = d.id and i.identifier_kind = 'invoice_number'
                order by i.first_seen_at asc, i.id asc limit 1) as invoice_number
         from deductions d
         left join debtors b on b.id = d.debtor_id
     )
     select distinct on (least(n.side_a, n.side_b), greatest(n.side_a, n.side_b))
            n.event_id::text as event_id,
            n.event_time,
            n.basis,
            a.id as a_id,
            ${sideColumns('a', 'a')},
            z.id as z_id,
            ${sideColumns('z', 'z')}
       from named n
       -- Both halves, through RLS: a pair naming a deduction this tenant cannot
       -- see is not a pair this tenant is shown, and it is the database that
       -- decides that rather than a filter here.
       join summary a on a.id = n.side_a
       join summary z on z.id = n.side_b
      where not exists (
        select 1 from answered v
         where v.low_id in (n.side_a, n.side_b) and v.high_id in (n.side_a, n.side_b)
      )
        -- A pair whose other half is merged into something is not a question
        -- about the deduction any more; it comes back if that merge is undone.
        and not exists (select 1 from merged_away m where m.id in (n.side_a, n.side_b))
        and ($2::text is null or n.side_a = $2 or n.side_b = $2)
      order by least(n.side_a, n.side_b), greatest(n.side_a, n.side_b), n.event_id desc
      limit $3`,
    [PAIR_NAMED, only, Math.min(limit, POSSIBLE_DUPLICATES_MAX_LIMIT)],
  );

  return rows
    .map((row) => {
      const [older, newer] = olderFirst(
        candidate(row.a_id, sideOf(row, 'a')),
        candidate(row.z_id, sideOf(row, 'z')),
      );
      return {
        noticedAt: new Date(row.event_time).toISOString(),
        basis: basisOf(row.basis),
        older,
        newer,
        eventId: row.event_id,
      };
    })
    // `distinct on` fixed the order the pairs were deduplicated in; a reviewer
    // wants the most recently noticed first, which is this one.
    .sort((left, right) => (left.eventId < right.eventId ? 1 : -1))
    .map(({ eventId: _eventId, ...pair }) => pair);
}

// ---------------------------------------------------------------------------
// 6a. Pairs a remittance line recorded but never named (audit F1)
// ---------------------------------------------------------------------------
//
// Until the fix beside `openCaseForLine`, a remittance line that probably
// matched a case already open wrote the match into its own `case.discovered`
// event (`probable_duplicate_of`) and nowhere else, so the pair never reached
// `possibleDuplicates` and could never be answered or merged. These two are the
// one-off repair: the list of such matches, and the write that names one in
// `case.possible_duplicate`'s own shape. Nothing is re-read from a document and
// nothing is inferred: the pair and its basis are what the `case.discovered`
// event already said, and the write reads them from that event rather than from
// its caller.

/** One match a `case.discovered` event recorded that no pair event names yet. */
export interface UnnamedProbablePair {
  /** The case the event is on — the one opened second. */
  readonly deductionId: string;
  /** The case it probably duplicates. */
  readonly of: string;
  /** Names of the facts that agreed, as the event recorded them. */
  readonly basis: readonly string[];
  /** The `case.discovered` event the pair is read from. */
  readonly discoveredEventId: string;
}

/**
 * The matches, oldest first. A pair already named in either direction is not
 * listed, so a second run of the backfill lists nothing. The other half must be
 * a case this tenant can see — RLS decides, as it does for the pair list.
 */
export async function unnamedProbablePairs(
  client: PoolClient,
  options?: { readonly limit?: number },
): Promise<readonly UnnamedProbablePair[]> {
  const limit = options?.limit ?? POSSIBLE_DUPLICATES_MAX_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`unnamedProbablePairs limit must be a positive integer, got ${String(limit)}`);
  }
  const { rows } = await client.query<{
    event_id: string;
    deduction_id: string;
    of: string;
    basis: unknown;
  }>(
    `select e.id::text as event_id,
            e.deduction_id::text as deduction_id,
            lower(x.of) as of,
            coalesce(e.payload->'probable_duplicate_basis', '[]'::jsonb) as basis
       from deduction_events e
       cross join lateral jsonb_array_elements_text(
         case when jsonb_typeof(e.payload->'probable_duplicate_of') = 'array'
              then e.payload->'probable_duplicate_of' else '[]'::jsonb end
       ) as x(of)
      where e.event_type = 'case.discovered'
        and exists (select 1 from deductions o where o.id::text = lower(x.of))
        and not exists (
          select 1 from deduction_events p
           where p.event_type = $1
             and ((p.deduction_id = e.deduction_id and lower(p.payload->>'of') = lower(x.of))
               or (p.deduction_id::text = lower(x.of)
                   and lower(p.payload->>'of') = e.deduction_id::text))
        )
      order by e.id asc, lower(x.of) asc
      limit $2`,
    [PAIR_NAMED, Math.min(limit, POSSIBLE_DUPLICATES_MAX_LIMIT)],
  );
  return rows.map((row) => ({
    deductionId: row.deduction_id,
    of: row.of,
    basis: basisOf(row.basis),
    discoveredEventId: row.event_id,
  }));
}

/**
 * Names one recorded match as a pair: one `case.possible_duplicate` on the case
 * the `case.discovered` event is on, `{ of, basis }` as `openCase` writes it,
 * plus the event it was read from. Idempotent: both cases are locked in id
 * order — the verdict write's order, so the two cannot deadlock — and a pair
 * already named in either direction answers `already_named` and writes nothing.
 * A caller naming a match the event does not record is refused by name.
 */
export async function namePossibleDuplicate(
  client: PoolClient,
  tenant: TenantContext,
  input: {
    readonly discoveredEventId: string;
    readonly of: string;
    readonly recordedBy: string;
  },
): Promise<'named' | 'already_named'> {
  const action = 'naming a possible duplicate';
  requireCaller(input.recordedBy, tenant.userId, action);

  const { rows: found } = await client.query<{ deduction_id: string; payload: Record<string, unknown> }>(
    `select deduction_id::text as deduction_id, payload
       from deduction_events
      where id = $1::bigint and event_type = 'case.discovered'`,
    [input.discoveredEventId],
  );
  const discovered = found[0];
  const there = idKey(input.of);
  const recorded = Array.isArray(discovered?.payload['probable_duplicate_of'])
    ? (discovered.payload['probable_duplicate_of'] as unknown[])
        .filter((id): id is string => typeof id === 'string')
        .map(idKey)
    : [];
  if (discovered === undefined || !recorded.includes(there)) {
    throw new Error(
      `case.discovered event ${input.discoveredEventId} records no probable match with ${input.of}`,
    );
  }
  const here = idKey(discovered.deduction_id);
  if (here === there) {
    throw new NoSuchDuplicatePairError(discovered.deduction_id, input.of);
  }

  for (const deductionId of [here, there].sort()) {
    await lockCase(client, deductionId, action, input.recordedBy, WRITER_ROLES);
  }

  const { rows: named } = await client.query<{ one: number }>(
    `select 1 as one from deduction_events
      where event_type = $1
        and ((deduction_id::text = $2 and lower(payload->>'of') = $3)
          or (deduction_id::text = $3 and lower(payload->>'of') = $2))
      limit 1`,
    [PAIR_NAMED, here, there],
  );
  if (named.length > 0) return 'already_named';

  await appendEvent(client, tenant, here, PAIR_NAMED, {
    of: there,
    basis: basisOf(discovered.payload['probable_duplicate_basis']),
    backfilled_from_event: input.discoveredEventId,
  });
  return 'named';
}

export async function recordDuplicateVerdict(
  client: PoolClient,
  tenant: TenantContext,
  input: {
    readonly deductionId: string;
    readonly otherDeductionId: string;
    readonly verdict: DuplicateVerdict;
    readonly recordedBy: string;
    readonly merge?: boolean;
  },
): Promise<DuplicateVerdictRecord> {
  const action = 'answering a possible duplicate';
  requireCaller(input.recordedBy, tenant.userId, action);

  const here = idKey(input.deductionId);
  const there = idKey(input.otherDeductionId);
  // A case is not a duplicate of itself, and no event says it is — so this is
  // the same refusal a pair nobody named gets, rather than a second one.
  if (here === there) {
    throw new NoSuchDuplicatePairError(input.deductionId, input.otherDeductionId);
  }

  // Both cases, locked, in id order: two reviewers answering two overlapping
  // pairs at once take the same two rows in the same sequence and so cannot
  // deadlock. The lock is what makes the check below and the writes after it one
  // decision — READ COMMITTED lets two transactions both read no verdict and
  // both write one, and there is no unique index to catch the second.
  //
  // `lockCase` is also where the role and the visibility refusals come from: a
  // `read_only` member gets no row because `tenant_update` is gated on
  // `app.member_may_write()`, and another tenant's case is absent by name. Both
  // halves are locked, so a cross-tenant pair is refused on whichever half this
  // tenant cannot see.
  for (const deductionId of [here, there].sort()) {
    await lockCase(client, deductionId, action, input.recordedBy, WRITER_ROLES);
  }

  const { rows: named } = await client.query<{ basis: unknown }>(
    `select coalesce(e.payload->'basis', '[]'::jsonb) as basis
       from deduction_events e
      where e.event_type = $1
        and ((e.deduction_id::text = $2 and lower(e.payload->>'of') = $3)
          or (e.deduction_id::text = $3 and lower(e.payload->>'of') = $2))
      order by e.id asc
      limit 1`,
    [PAIR_NAMED, here, there],
  );
  const pair = named[0];
  if (pair === undefined) {
    throw new NoSuchDuplicatePairError(input.deductionId, input.otherDeductionId);
  }

  // The verdict standing on the pair, if one does. A verdict withdrawn by an
  // undone merge is not standing (ADR 0042 §5), and the pair may be answered
  // again; anything else is answered already, and the first answer stands.
  const { rows: answered } = await client.query<{
    verdict: DuplicateVerdict;
    event_time: Date | string;
  }>(
    `select v.verdict, v.event_time
       from duplicate_pair_verdicts v
      where v.low_id in ($1, $2) and v.high_id in ($1, $2)
        and v.verdict is not null`,
    [here, there],
  );
  const standing = answered[0];
  if (standing !== undefined) {
    throw new DuplicateVerdictAlreadyRecordedError(
      input.deductionId,
      input.otherDeductionId,
      standing.verdict,
      new Date(standing.event_time).toISOString(),
    );
  }

  // Which of the two was opened first. Derived rather than read off the event's
  // direction, so both sides of a pair get the same answer (ADR 0032 §4).
  const { rows: opened } = await client.query<{ id: string }>(
    `select d.id::text as id from deductions d
      where d.id::text in ($1, $2)
      order by d.created_at asc, d.id asc`,
    [here, there],
  );
  const older = opened[0]?.id;
  const newer = opened[1]?.id;
  if (older === undefined || newer === undefined) {
    // Unreachable: both were locked a moment ago inside this transaction.
    throw new CaseNotVisibleError(input.deductionId);
  }

  const basis = basisOf(pair.basis);
  const eventType = eventTypeFor(input.verdict);
  const payload = (of: string): Record<string, unknown> => ({
    of,
    verdict: input.verdict,
    // What the matcher said agreed, carried across so the answer and the
    // question are readable together. Names of facts, never their values
    // (invariant 4).
    basis,
    older_deduction_id: older,
    newer_deduction_id: newer,
    // Only on a confirmation. What ADR 0032 §4 said survives; a merge decides
    // for itself (ADR 0042 §2) and its row, not this field, is authoritative.
    ...(input.verdict === 'same' ? { surviving_deduction_id: older } : {}),
    recorded_by: input.recordedBy,
  });

  // One event per case, in one transaction, each naming the other. A verdict on
  // one side only would be a pair that reads as answered from one case and open
  // from the other, and the list and the case page read from different sides.
  await appendEvent(client, tenant, here, eventType, payload(there));
  await appendEvent(client, tenant, there, eventType, payload(here));

  // One click (ADR 0042 §7): "same" merges in this transaction when the
  // database allows it. A refusal is not a failure of the verdict, which stands
  // either way; the merge's own statement ran under a savepoint, so a refusal
  // leaves this transaction as the verdict left it.
  let merge: MergeOutcome | undefined;
  if (input.verdict === 'same' && input.merge === true) {
    try {
      merge = { kind: 'merged', merge: await mergeLockedPair(client, tenant, here, there, input.recordedBy) };
    } catch (error) {
      if (!(error instanceof MergeRefusedError)) throw error;
      merge = { kind: 'not_merged', reason: error.reason };
    }
  }

  const { rows: recorded } = await client.query<{ now: string }>(
    `select now()::text as now`,
  );

  return {
    verdict: input.verdict,
    deductionId: here,
    otherDeductionId: there,
    survivingDeductionId: merge?.kind === 'merged' ? merge.merge.survivingDeductionId : older,
    basis,
    recordedBy: input.recordedBy,
    recordedAt: new Date(recorded[0]?.now ?? Date.now()).toISOString(),
    ...(merge !== undefined ? { merge } : {}),
  };
}

// ---------------------------------------------------------------------------
// 7. Merging a confirmed pair, and undoing it (ADR 0042)
// ---------------------------------------------------------------------------
//
// The store inserts one `deduction_merges` row and reads back what happened.
// Which case survives, whether the pair may be merged at all, the state move and
// the events are the database's: `app.merge_survivor()`, `app.merge_refusal()`
// and the two triggers on the table. The reads here ask those same functions
// first, so a refusal arrives with its reason rather than as a failed statement,
// and the trigger is what decides when two people race.

/** The trigger's reason keys that mean "the pair changed under you". */
const STALE_HINTS = new Set(['wrong_survivor', 'stale_state', 'stale_verdict']);

/** A reason key from the database, as one of ours, or a loud refusal. */
function knownRefusal(value: string): MergeRefusal {
  if (isMergeRefusal(value)) return value;
  throw new Error(`the database refused a merge for a reason this build does not know: ${value}`);
}

/**
 * Turns the merge check's `RCM02` into a `MergeRefusedError`. Anything else —
 * including a hint this build has no word for — goes out as it came: a refusal
 * nobody can name is a bug, not a reason to show a reviewer.
 */
function translateMergeError(
  error: unknown,
  deductionId: string,
  otherDeductionId: string,
): Promise<unknown> {
  if (sqlState(error) === 'RCM02') {
    const hint = (error as { hint?: unknown } | null)?.hint;
    if (typeof hint === 'string') {
      if (STALE_HINTS.has(hint)) {
        return Promise.resolve(new MergeRefusedError('stale', deductionId, otherDeductionId));
      }
      if (isMergeRefusal(hint)) {
        return Promise.resolve(new MergeRefusedError(hint, deductionId, otherDeductionId));
      }
    }
  }
  // Two merges of one pair in flight at once: the second waits on the first's
  // row locks and then sees it, so this is the net under a race the check
  // already answers.
  if (sqlState(error) === '23505' && constraintName(error) === 'deduction_merges_once_per_pair') {
    return Promise.resolve(new MergeRefusedError('merged_before', deductionId, otherDeductionId));
  }
  return Promise.resolve(error);
}

/**
 * The merge itself, on two cases this transaction already holds. Used by the
 * one-click verdict and by the Merge button alike, so there is one way a merge
 * row is written.
 */
async function mergeLockedPair(
  client: PoolClient,
  tenant: TenantContext,
  a: string,
  b: string,
  mergedBy: string,
): Promise<MergeRecord> {
  const { rows: asked } = await client.query<{ refusal: string | null; survivor: string | null }>(
    `select app.merge_refusal($1::uuid, $2::uuid) as refusal,
            app.merge_survivor($1::uuid, $2::uuid)::text as survivor`,
    [a, b],
  );
  const refusal = asked[0]?.refusal ?? null;
  if (refusal !== null) throw new MergeRefusedError(knownRefusal(refusal), a, b);
  const survivor = asked[0]?.survivor ?? null;
  if (survivor === null) {
    // `merge_refusal` answers `both_filed` or `not_visible` whenever this is null.
    throw new Error(`cases ${a} and ${b} may be merged and yet have no survivor`);
  }
  const loser = survivor === a ? b : a;

  // Everything the row must say is read in the statement that writes it, from
  // the rows this transaction holds: the state and amount of the loser, and the
  // verdict standing on the pair. The check trigger compares each of them again.
  const { rows } = await translating(
    client,
    'merge_duplicate',
    () =>
      client.query<{ id: string; state_before: CaseState; created_at: Date | string }>(
        `insert into deduction_merges
           (org_id, merged_deduction_id, surviving_deduction_id, action,
            state_before, amount_cents, verdict_event_id, recorded_by)
         select $1, d.id, $3::text::uuid, 'merge', d.state, d.deduction_amount_cents,
                (select v.event_id from duplicate_pair_verdicts v
                  where v.low_id in ($2::text, $3::text) and v.high_id in ($2::text, $3::text)),
                $4
           from deductions d
          where d.id = $2::text::uuid
         returning id::text as id, state_before, created_at`,
        [tenant.orgId, loser, survivor, mergedBy],
      ),
    (error) => translateMergeError(error, a, b),
  );
  const row = rows[0];
  if (row === undefined) throw new CaseNotVisibleError(loser);
  return {
    mergeId: row.id,
    mergedDeductionId: loser,
    survivingDeductionId: survivor,
    stateBefore: row.state_before,
    recordedBy: mergedBy,
    recordedAt: new Date(row.created_at).toISOString(),
  };
}

export async function mergeConfirmedDuplicate(
  client: PoolClient,
  tenant: TenantContext,
  input: {
    readonly deductionId: string;
    readonly otherDeductionId: string;
    readonly mergedBy: string;
  },
): Promise<MergeRecord> {
  const action = 'merging a confirmed duplicate';
  requireCaller(input.mergedBy, tenant.userId, action);
  const here = idKey(input.deductionId);
  const there = idKey(input.otherDeductionId);
  if (here === there) throw new MergeRefusedError('not_confirmed', here, there);
  // In id order, as the check trigger takes them, so two merges over
  // overlapping pairs cannot deadlock; and where the role and visibility
  // refusals come from, by name.
  for (const deductionId of [here, there].sort()) {
    await lockCase(client, deductionId, action, input.mergedBy, WRITER_ROLES);
  }
  return mergeLockedPair(client, tenant, here, there, input.mergedBy);
}

export async function undoMerge(
  client: PoolClient,
  tenant: TenantContext,
  input: { readonly deductionId: string; readonly undoneBy: string },
): Promise<UnmergeRecord> {
  const action = 'undoing a merge';
  requireCaller(input.undoneBy, tenant.userId, action);
  const loser = idKey(input.deductionId);

  const { rows: current } = await client.query<{ surviving: string }>(
    `select c.surviving_deduction_id::text as surviving
       from deduction_merges_current c
      where c.merged_deduction_id::text = $1`,
    [loser],
  );
  const surviving = current[0]?.surviving;
  if (surviving === undefined) {
    // Visible and a writer's to act on, and still nothing to undo — or else
    // the named refusal that says which of those it is not.
    await lockCase(client, loser, action, input.undoneBy, WRITER_ROLES);
    throw new MergeRefusedError('not_merged', loser);
  }
  for (const deductionId of [loser, surviving].sort()) {
    await lockCase(client, deductionId, action, input.undoneBy, WRITER_ROLES);
  }

  const { rows } = await translating(
    client,
    'undo_merge',
    () =>
      client.query<{ id: string; created_at: Date | string }>(
        `insert into deduction_merges
           (org_id, merged_deduction_id, surviving_deduction_id, action, recorded_by)
         values ($1, $2::uuid, $3::uuid, 'unmerge', $4)
         returning id::text as id, created_at`,
        [tenant.orgId, loser, surviving, input.undoneBy],
      ),
    (error) => translateMergeError(error, loser, surviving),
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`insert into deduction_merges (unmerge) wrote no row`);

  // The database put it back; this reads where.
  const { rows: restored } = await client.query<{ state: CaseState }>(
    `select state from deductions where id = $1::uuid`,
    [loser],
  );
  const state = restored[0]?.state;
  if (state === undefined) throw new CaseNotVisibleError(loser);
  return {
    unmergeId: row.id,
    mergedDeductionId: loser,
    survivingDeductionId: surviving,
    restoredState: state,
    recordedBy: input.undoneBy,
    recordedAt: new Date(row.created_at).toISOString(),
  };
}

interface MergeSideRow {
  id: string;
  claim_id: string | null;
  amount: string;
  state: CaseState;
}

function mergeSide(row: MergeSideRow) {
  return {
    deductionId: row.id,
    ...(row.claim_id !== null ? { claimId: row.claim_id } : {}),
    deductionAmountCents: exactCents(row.amount, 'deduction_amount_cents'),
    state: row.state,
  };
}

export async function mergesFor(client: PoolClient, deductionId: string): Promise<CaseMerges> {
  const id = idKey(deductionId);

  const { rows: into } = await client.query<
    MergeSideRow & { merge_id: string; merged_at: Date | string; merged_by: string }
  >(
    `select s.id::text as id, s.claim_id, s.deduction_amount_cents::text as amount, s.state,
            c.merge_id::text as merge_id, c.merged_at, c.recorded_by::text as merged_by
       from deduction_merges_current c
       join deductions s on s.id = c.surviving_deduction_id
      where c.merged_deduction_id::text = $1`,
    [id],
  );

  const { rows: absorbed } = await client.query<
    MergeSideRow & { merge_id: string; merged_at: Date | string }
  >(
    `select l.id::text as id, l.claim_id, l.deduction_amount_cents::text as amount, l.state,
            c.merge_id::text as merge_id, c.merged_at
       from deduction_merges_current c
       join deductions l on l.id = c.merged_deduction_id
      where c.surviving_deduction_id::text = $1
      order by c.merged_at asc, c.merge_id asc`,
    [id],
  );

  // Confirmed and not merged: every pair with "same" standing on it that names
  // this case, whose other half this tenant can see, and which is not merged
  // right now — each with the database's reason, or none when Merge would work.
  const { rows: confirmed } = await client.query<MergeSideRow & { refusal: string | null }>(
    `select o.id::text as id, o.claim_id, o.deduction_amount_cents::text as amount, o.state,
            app.merge_refusal($1::text::uuid, o.id) as refusal
       from duplicate_pair_verdicts v
       join deductions o
         on o.id::text = case when v.low_id = $1::text then v.high_id else v.low_id end
      where v.verdict = 'same'
        and $1::text in (v.low_id, v.high_id)
        and not exists (
          select 1 from deduction_merges_current c
           where (c.merged_deduction_id::text = $1::text and c.surviving_deduction_id = o.id)
              or (c.merged_deduction_id = o.id and c.surviving_deduction_id::text = $1::text))
      order by o.created_at asc, o.id asc`,
    [id],
  );

  const mergedInto = into[0];
  return {
    ...(mergedInto !== undefined
      ? {
          mergedInto: {
            ...mergeSide(mergedInto),
            mergeId: mergedInto.merge_id,
            mergedAt: new Date(mergedInto.merged_at).toISOString(),
            mergedBy: mergedInto.merged_by,
          },
        }
      : {}),
    absorbed: absorbed.map((row) => ({
      ...mergeSide(row),
      mergeId: row.merge_id,
      mergedAt: new Date(row.merged_at).toISOString(),
    })),
    confirmedNotMerged: confirmed.map((row) => ({
      ...mergeSide(row),
      ...(row.refusal !== null ? { refusal: knownRefusal(row.refusal) } : {}),
    })),
  };
}

async function latestPacket(
  client: PoolClient,
  decisionId: string,
): Promise<(PacketRecord & { readonly deductionId: string }) | undefined> {
  const { rows } = await client.query<PacketRow>(
    `select id, deduction_id, decision_id, content_hash, narrative, file_document_ids,
            assembled_by, created_at
       from packets where decision_id = $1 order by created_at desc, id desc limit 1`,
    [decisionId],
  );
  const row = rows[0];
  return row === undefined ? undefined : toPacket(row);
}
