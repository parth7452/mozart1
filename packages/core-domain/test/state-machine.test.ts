import { describe, expect, it } from 'vitest';
import {
  CASE_STATES,
  CLOSED_STATES,
  INITIAL_STATE,
  MERGEABLE_STATES,
  TERMINAL_STATES,
  TRANSITIONS,
  TransitionError,
  applyTransition,
  canTransition,
  findTransition,
  isClosed,
  isMergeable,
  isReachable,
  isTerminal,
  transitionsBetween,
  transitionsFrom,
  type CaseState,
  type GuardName,
  type Transition,
} from '../src/state-machine';

describe('the case state machine', () => {
  it('only names states that exist', () => {
    for (const t of TRANSITIONS) {
      expect(CASE_STATES).toContain(t.from);
      expect(CASE_STATES).toContain(t.to);
    }
  });

  it('reaches every state from the initial one', () => {
    for (const state of CASE_STATES) {
      if (state === INITIAL_STATE) continue;
      expect(isReachable(INITIAL_STATE, state), `${state} is unreachable`).toBe(true);
    }
  });

  it('leaves no way out of a terminal state', () => {
    for (const state of TERMINAL_STATES) {
      expect(transitionsFrom(state)).toHaveLength(0);
      expect(isTerminal(state)).toBe(true);
    }
  });

  it('gives every edge a guard, a workflow and an idempotency story', () => {
    for (const t of TRANSITIONS) {
      expect(t.workflow, `${t.from} → ${t.to}`).not.toBe('');
      expect(t.idempotency, `${t.from} → ${t.to}`).not.toBe('');
      expect(t.trigger, `${t.from} → ${t.to}`).not.toBe('');
    }
  });

  // The invariant this file exists to prove.
  it('cannot reach submitted or written_off without passing through awaiting_approval', () => {
    for (const start of CASE_STATES) {
      if (start === 'awaiting_approval') continue;
      for (const outcome of ['submitted', 'written_off'] as const) {
        if (start === outcome) continue;
        expect(
          isReachable(start, outcome, { avoid: ['awaiting_approval'] }),
          `${start} → ${outcome} bypasses approval`,
        ).toBe(false);
      }
    }
  });

  // Every edge out of awaiting_approval needs an approval, bar one: merging the
  // case away as a confirmed duplicate (ADR 0042), which files nothing and whose
  // only way on is back to awaiting_approval itself. That one is pinned to
  // exactly that shape, so it cannot become a way round the gate.
  it('requires an approval row on every edge out of awaiting_approval', () => {
    const edges = transitionsFrom('awaiting_approval');
    const filing = edges.filter((edge) => edge.trigger !== 'case.merged_into');
    expect(filing.length).toBeGreaterThan(0);
    for (const edge of filing) {
      expect(edge.guards).toContain('approval_row_exists');
    }
    expect(edges.filter((edge) => edge.trigger === 'case.merged_into')).toEqual([
      expect.objectContaining({ to: 'merged', guards: ['duplicate_confirmed_by_person'] }),
    ]);
  });

  it('refuses a transition whose guard is unmet, and names the guard', () => {
    expect(() =>
      applyTransition('awaiting_approval', 'submitted', 'submission.recorded'),
    ).toThrow(/approval_row_exists/);
    expect(() =>
      applyTransition('awaiting_approval', 'submitted', 'submission.recorded', {
        approval_row_exists: true,
      }),
    ).not.toThrow();
  });

  it('refuses transitions that are not in the table', () => {
    expect(() => applyTransition('discovered', 'submitted', 'submission.recorded')).toThrow(
      TransitionError,
    );
    expect(canTransition('discovered', 'submitted')).toBe(false);
    expect(canTransition('won', 'submitted' as CaseState)).toBe(false);
  });

  it('routes a decided case only to the three routing states', () => {
    const routed = transitionsFrom('decided').filter((t) => t.trigger === 'decision.routed');
    expect(routed.map((t) => t.to).sort()).toEqual([
      'analyst_review',
      'auto_dispute_queued',
      'auto_writeoff_queued',
    ]);
    // Besides routing, a decided case can only be merged away (ADR 0042).
    expect(
      transitionsFrom('decided')
        .filter((t) => t.trigger !== 'decision.routed')
        .map((t) => `${t.to} on ${t.trigger}`),
    ).toEqual(['merged on case.merged_into']);
  });

  // An edge is keyed by (from, to, trigger): the same pair of states can be
  // crossed by two different facts, and each carries its own guards.
  it('has no duplicate edges', () => {
    const keys = TRANSITIONS.map((t) => `${t.from}→${t.to} via ${t.trigger}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  describe('the Phase 3 human path (ADR 0020)', () => {
    it('lets a human decision route a classified case straight to analyst review', () => {
      const edge = findTransition('classified', 'analyst_review', 'decision.recorded');
      expect(edge).toBeDefined();
      expect(edge?.guards).toEqual(['human_decision_recorded']);
      expect(edge?.workflow).toBe('decide.human');
    });

    it('still makes that case pass through awaiting_approval to be submitted', () => {
      const walk: readonly [CaseState, CaseState, string, GuardName][] = [
        ['classified', 'analyst_review', 'decision.recorded', 'human_decision_recorded'],
        [
          'analyst_review',
          'awaiting_approval',
          'packet.assembled',
          'packet_assembled_and_submission_safe',
        ],
        ['awaiting_approval', 'submitted', 'submission.recorded', 'approval_row_exists'],
        ['submitted', 'partial', 'outcome.recorded', 'outcome_recorded_by_human'],
      ];
      for (const [from, to, trigger, guard] of walk) {
        expect(() => applyTransition(from, to, trigger, { [guard]: true })).not.toThrow();
      }
      expect(
        isReachable('classified', 'submitted', { avoid: ['awaiting_approval'] }),
      ).toBe(false);
    });

    it('keeps the detected outcome edges alongside the recorded ones', () => {
      for (const outcome of ['won', 'partial', 'lost'] as const) {
        const triggers = transitionsBetween('submitted', outcome)
          .map((t) => t.trigger)
          .sort();
        expect(triggers).toEqual(['outcome.detected', 'outcome.recorded']);
      }
    });

    it('takes the edge the named trigger carries, not merely the first between the pair', () => {
      // outcome.detected is listed first in the table. The trigger, not the
      // listing order and not whichever guard happens to be set, is what picks.
      expect(
        applyTransition('submitted', 'won', 'outcome.recorded', {
          outcome_recorded_by_human: true,
        }).trigger,
      ).toBe('outcome.recorded');
      expect(
        applyTransition('submitted', 'won', 'outcome.detected', { outcome_detected: true })
          .trigger,
      ).toBe('outcome.detected');
    });

    // The reason `trigger` is required: with the pair alone, one edge's guard
    // would answer for the other's, and the case would move on a fact that
    // never happened.
    it('will not move a case on one edge because the other edge is satisfied', () => {
      expect(() =>
        applyTransition('submitted', 'won', 'outcome.recorded', { outcome_detected: true }),
      ).toThrow(/outcome_recorded_by_human/);
      expect(() =>
        applyTransition('submitted', 'won', 'outcome.detected', {
          outcome_recorded_by_human: true,
        }),
      ).toThrow(/outcome_detected/);
    });

    it('names the unmet guard of the edge that was asked for, and only that one', () => {
      expect(() => applyTransition('submitted', 'won', 'outcome.recorded')).toThrow(
        /outcome_recorded_by_human/,
      );
      expect(() => applyTransition('submitted', 'won', 'outcome.recorded')).not.toThrow(
        /outcome_detected/,
      );
      expect(() => applyTransition('submitted', 'won', 'outcome.detected')).toThrow(
        /outcome_detected/,
      );
    });

    it('refuses an edge asked for by the wrong trigger', () => {
      expect(canTransition('classified', 'analyst_review', 'outcome.recorded')).toBe(false);
      expect(() =>
        applyTransition('classified', 'analyst_review', 'outcome.recorded', {
          human_decision_recorded: true,
        }),
      ).toThrow(TransitionError);
    });

    // A duplicate `(from, to, trigger)` whose guards are both satisfiable is a
    // bug in the table. It is caught rather than silently resolved, because
    // "whichever came first" is not an answer on a path that moves money.
    it('refuses to choose between two edges satisfied at once', () => {
      // The table has no such pair and `has no duplicate edges` keeps it that
      // way, so the duplicate is added here to prove what happens if one ever
      // arrives: a refusal naming the table as the bug, not a coin flip. The
      // row is taken back out whatever the assertion does.
      const table = TRANSITIONS as Transition[];
      const before = table.length;
      table.push({
        from: 'submitted',
        to: 'won',
        trigger: 'outcome.recorded',
        guards: ['outcome_recorded_by_human'],
        workflow: 'record.outcome (a duplicate that must not exist)',
        idempotency: 'n/a',
      });
      try {
        expect(() =>
          applyTransition('submitted', 'won', 'outcome.recorded', {
            outcome_recorded_by_human: true,
          }),
        ).toThrow(/ambiguous/);
      } finally {
        table.length = before;
      }
      expect(TRANSITIONS).toHaveLength(before);
    });

    it('gives the two new guards to the edges that need them and to nothing else', () => {
      const guarded = (g: GuardName) =>
        TRANSITIONS.filter((t) => t.guards.includes(g)).map((t) => `${t.from}→${t.to}`);
      expect(guarded('human_decision_recorded')).toEqual(['classified→analyst_review']);
      expect(guarded('outcome_recorded_by_human').sort()).toEqual([
        'submitted→lost',
        'submitted→partial',
        'submitted→won',
      ]);
    });
  });

  describe('merging a confirmed duplicate (ADR 0042)', () => {
    it('is closed but not terminal: an undo is its way out', () => {
      expect(isClosed('merged')).toBe(true);
      expect(isTerminal('merged')).toBe(false);
      expect(CLOSED_STATES).toEqual([...TERMINAL_STATES, 'merged']);
      for (const state of TERMINAL_STATES) expect(isClosed(state)).toBe(true);
    });

    it('merges away only a case that has not been filed', () => {
      for (const state of CASE_STATES) {
        const filedOrAfter = (['submitted', 'written_off', 'won', 'lost', 'partial'] as const)
          .some((filed) => filed === state || isReachable(filed, state, { avoid: ['merged'] }));
        if (state === 'merged') continue;
        expect(isMergeable(state), state).toBe(!filedOrAfter);
      }
      expect(MERGEABLE_STATES).toHaveLength(9);
    });

    it('enters merged from every mergeable state, and leaves only back to one', () => {
      for (const state of MERGEABLE_STATES) {
        expect(
          applyTransition(state, 'merged', 'case.merged_into', {
            duplicate_confirmed_by_person: true,
          }).workflow,
        ).toBe('merge.duplicate');
        expect(
          applyTransition('merged', state, 'case.merge_undone', { merge_undone_by_person: true })
            .workflow,
        ).toBe('unmerge.duplicate');
      }
      expect(transitionsFrom('merged').map((t) => t.to).sort()).toEqual(
        [...MERGEABLE_STATES].sort(),
      );
      expect(() =>
        applyTransition('submitted', 'merged', 'case.merged_into', {
          duplicate_confirmed_by_person: true,
        }),
      ).toThrow(TransitionError);
    });

    it('needs a person on both edges', () => {
      expect(() => applyTransition('classified', 'merged', 'case.merged_into')).toThrow(
        /duplicate_confirmed_by_person/,
      );
      expect(() => applyTransition('merged', 'classified', 'case.merge_undone')).toThrow(
        /merge_undone_by_person/,
      );
    });

    it('opens no way to a filing that skips awaiting_approval', () => {
      for (const outcome of ['submitted', 'written_off'] as const) {
        expect(isReachable('merged', outcome, { avoid: ['awaiting_approval'] })).toBe(false);
      }
    });
  });
});
