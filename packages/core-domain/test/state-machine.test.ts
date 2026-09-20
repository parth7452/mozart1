import { describe, expect, it } from 'vitest';
import {
  CASE_STATES,
  INITIAL_STATE,
  TERMINAL_STATES,
  TRANSITIONS,
  TransitionError,
  applyTransition,
  canTransition,
  findTransition,
  isReachable,
  isTerminal,
  transitionsBetween,
  transitionsFrom,
  type CaseState,
  type GuardName,
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

  it('requires an approval row on every edge out of awaiting_approval', () => {
    const edges = transitionsFrom('awaiting_approval');
    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges) {
      expect(edge.guards).toContain('approval_row_exists');
    }
  });

  it('refuses a transition whose guard is unmet, and names the guard', () => {
    expect(() => applyTransition('awaiting_approval', 'submitted')).toThrow(
      /approval_row_exists/,
    );
    expect(() =>
      applyTransition('awaiting_approval', 'submitted', { approval_row_exists: true }),
    ).not.toThrow();
  });

  it('refuses transitions that are not in the table', () => {
    expect(() => applyTransition('discovered', 'submitted')).toThrow(TransitionError);
    expect(canTransition('discovered', 'submitted')).toBe(false);
    expect(canTransition('won', 'submitted' as CaseState)).toBe(false);
  });

  it('routes a decided case only to the three routing states', () => {
    expect(transitionsFrom('decided').map((t) => t.to).sort()).toEqual([
      'analyst_review',
      'auto_dispute_queued',
      'auto_writeoff_queued',
    ]);
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
      const walk: readonly [CaseState, CaseState, GuardName][] = [
        ['classified', 'analyst_review', 'human_decision_recorded'],
        ['analyst_review', 'awaiting_approval', 'packet_assembled_and_submission_safe'],
        ['awaiting_approval', 'submitted', 'approval_row_exists'],
        ['submitted', 'partial', 'outcome_recorded_by_human'],
      ];
      for (const [from, to, guard] of walk) {
        expect(() => applyTransition(from, to, { [guard]: true })).not.toThrow();
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

    it('takes whichever edge between a pair has its guards met, not merely the first', () => {
      // outcome.detected is listed first. A human-recorded outcome must still
      // move the case, and a detected one must still move it after that.
      expect(
        applyTransition('submitted', 'won', { outcome_recorded_by_human: true }).trigger,
      ).toBe('outcome.recorded');
      expect(applyTransition('submitted', 'won', { outcome_detected: true }).trigger).toBe(
        'outcome.detected',
      );
    });

    it('names every candidate edge when none of their guards are met', () => {
      expect(() => applyTransition('submitted', 'won')).toThrow(/outcome_detected/);
      expect(() => applyTransition('submitted', 'won')).toThrow(/outcome_recorded_by_human/);
    });

    it('refuses an edge asked for by the wrong trigger', () => {
      expect(canTransition('classified', 'analyst_review', 'outcome.recorded')).toBe(false);
      expect(() =>
        applyTransition(
          'classified',
          'analyst_review',
          { human_decision_recorded: true },
          'outcome.recorded',
        ),
      ).toThrow(TransitionError);
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
});
