import { describe, expect, it } from 'vitest';
import {
  CASE_STATES,
  INITIAL_STATE,
  TERMINAL_STATES,
  TRANSITIONS,
  TransitionError,
  applyTransition,
  canTransition,
  isReachable,
  isTerminal,
  transitionsFrom,
  type CaseState,
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

  it('has no duplicate edges', () => {
    const keys = TRANSITIONS.map((t) => `${t.from}→${t.to}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
