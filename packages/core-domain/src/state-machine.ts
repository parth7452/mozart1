/**
 * The case state machine (plan §6).
 *
 * The table is data, so it can be asserted against: the tests prove that no
 * path reaches `submitted` or `written_off` without passing through
 * `awaiting_approval`. The database enforces the same thing independently — if
 * these two ever disagree, the database wins and this file is the bug.
 */

export const CASE_STATES = [
  'discovered',
  'classified',
  'evidence_pending',
  'evidence_complete',
  'decided',
  'auto_dispute_queued',
  'analyst_review',
  'auto_writeoff_queued',
  'awaiting_approval',
  'submitted',
  'won',
  'lost',
  'partial',
  'written_off',
] as const;

export type CaseState = (typeof CASE_STATES)[number];

export const TERMINAL_STATES = ['won', 'lost', 'partial', 'written_off'] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];

/** Conditions the orchestrator must evaluate before a transition is legal. */
export type GuardName =
  | 'doc_type_known'
  | 'classification_confidence_meets_tenant_minimum'
  | 'all_required_evidence_present'
  | 'decision_schemas_b_and_c_passed'
  | 'confidence_within_tenant_dispute_ceiling'
  | 'amount_within_tenant_writeoff_ceiling'
  | 'analyst_requested_more_evidence'
  | 'packet_assembled_and_submission_safe'
  | 'approval_row_exists'
  | 'outcome_detected';

export interface Transition {
  readonly from: CaseState;
  readonly to: CaseState;
  /** The event that carries the case across this edge. */
  readonly trigger: string;
  readonly guards: readonly GuardName[];
  /** The Inngest function that owns the edge (plan §6). */
  readonly workflow: string;
  /** How re-delivery of the same event is made harmless. */
  readonly idempotency: string;
}

export const TRANSITIONS: readonly Transition[] = [
  {
    from: 'discovered',
    to: 'classified',
    trigger: 'document.classified',
    guards: ['doc_type_known'],
    workflow: 'classify.case',
    idempotency: 'key = sha256(document); step memoised',
  },
  {
    from: 'classified',
    to: 'evidence_pending',
    trigger: 'evidence.planned',
    guards: ['classification_confidence_meets_tenant_minimum'],
    workflow: 'plan.evidence',
    idempotency: 'checklist upsert by (deduction_id, evidence_type)',
  },
  {
    from: 'evidence_pending',
    to: 'evidence_complete',
    trigger: 'evidence.sufficient',
    guards: ['all_required_evidence_present'],
    workflow: 'score.evidence',
    idempotency: 'pure function of the current evidence set',
  },
  {
    from: 'evidence_complete',
    to: 'decided',
    trigger: 'decision.recorded',
    guards: ['decision_schemas_b_and_c_passed'],
    workflow: 'decide.case',
    idempotency: 'skip when input_state_hash is unchanged',
  },
  {
    from: 'decided',
    to: 'auto_dispute_queued',
    trigger: 'decision.routed',
    guards: ['confidence_within_tenant_dispute_ceiling'],
    workflow: 'route.decision',
    idempotency: 'deterministic in the decision row',
  },
  {
    from: 'decided',
    to: 'analyst_review',
    trigger: 'decision.routed',
    guards: [],
    workflow: 'route.decision',
    idempotency: 'deterministic in the decision row',
  },
  {
    from: 'decided',
    to: 'auto_writeoff_queued',
    trigger: 'decision.routed',
    guards: ['amount_within_tenant_writeoff_ceiling'],
    workflow: 'route.decision',
    idempotency: 'deterministic in the decision row',
  },
  {
    from: 'analyst_review',
    to: 'evidence_pending',
    trigger: 'evidence.requested',
    guards: ['analyst_requested_more_evidence'],
    workflow: 'plan.evidence',
    idempotency: 'checklist upsert by (deduction_id, evidence_type)',
  },
  {
    from: 'auto_dispute_queued',
    to: 'awaiting_approval',
    trigger: 'packet.assembled',
    guards: ['packet_assembled_and_submission_safe'],
    workflow: 'assemble.packet',
    idempotency: 'packet is content-hashed',
  },
  {
    from: 'analyst_review',
    to: 'awaiting_approval',
    trigger: 'packet.assembled',
    guards: ['packet_assembled_and_submission_safe'],
    workflow: 'assemble.packet',
    idempotency: 'packet is content-hashed',
  },
  {
    from: 'auto_writeoff_queued',
    to: 'awaiting_approval',
    trigger: 'packet.assembled',
    guards: ['packet_assembled_and_submission_safe'],
    workflow: 'assemble.packet',
    idempotency: 'packet is content-hashed',
  },
  {
    from: 'awaiting_approval',
    to: 'submitted',
    trigger: 'submission.recorded',
    guards: ['approval_row_exists'],
    workflow: 'submit.packet (waitForEvent approval.granted)',
    idempotency: 'unique (decision_id, channel)',
  },
  {
    from: 'awaiting_approval',
    to: 'written_off',
    trigger: 'writeoff.recorded',
    guards: ['approval_row_exists'],
    workflow: 'writeoff.case (waitForEvent approval.granted)',
    idempotency: 'unique (decision_id)',
  },
  {
    from: 'submitted',
    to: 'won',
    trigger: 'outcome.detected',
    guards: ['outcome_detected'],
    workflow: 'detect.outcome',
    idempotency: 'outcome events are append-only',
  },
  {
    from: 'submitted',
    to: 'lost',
    trigger: 'outcome.detected',
    guards: ['outcome_detected'],
    workflow: 'detect.outcome',
    idempotency: 'outcome events are append-only',
  },
  {
    from: 'submitted',
    to: 'partial',
    trigger: 'outcome.detected',
    guards: ['outcome_detected'],
    workflow: 'detect.outcome',
    idempotency: 'outcome events are append-only',
  },
];

export const INITIAL_STATE: CaseState = 'discovered';

export class TransitionError extends Error {}

export function isTerminal(state: CaseState): state is TerminalState {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

export function transitionsFrom(state: CaseState): readonly Transition[] {
  return TRANSITIONS.filter((t) => t.from === state);
}

export function findTransition(from: CaseState, to: CaseState): Transition | undefined {
  return TRANSITIONS.find((t) => t.from === from && t.to === to);
}

export function canTransition(from: CaseState, to: CaseState): boolean {
  return findTransition(from, to) !== undefined;
}

/**
 * Moves a case, or explains why it cannot move. Unsatisfied guards are named —
 * a silent refusal to advance is the failure mode this exists to prevent.
 */
export function applyTransition(
  from: CaseState,
  to: CaseState,
  guards: Partial<Record<GuardName, boolean>> = {},
): Transition {
  const transition = findTransition(from, to);
  if (!transition) {
    throw new TransitionError(`illegal transition ${from} → ${to}`);
  }
  const unmet = transition.guards.filter((g) => guards[g] !== true);
  if (unmet.length > 0) {
    throw new TransitionError(
      `transition ${from} → ${to} blocked by unmet guard(s): ${unmet.join(', ')}`,
    );
  }
  return transition;
}

/** Breadth-first reachability, optionally forbidding states along the way. */
export function isReachable(
  from: CaseState,
  to: CaseState,
  options: { avoid?: readonly CaseState[] } = {},
): boolean {
  const avoid = new Set<CaseState>(options.avoid ?? []);
  if (avoid.has(from)) return false;
  const seen = new Set<CaseState>([from]);
  const queue: CaseState[] = [from];
  while (queue.length > 0) {
    const current = queue.shift() as CaseState;
    for (const next of transitionsFrom(current).map((t) => t.to)) {
      if (next === to) return true;
      if (avoid.has(next) || seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return false;
}
