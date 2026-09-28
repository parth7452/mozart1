/**
 * The credential in the clear, for one run (ADR 0057 §7-8): the TOTP code
 * computed as it is typed, never one about to expire and never one typed
 * before for the same connection, and a source that stops answering once the
 * run lets it go.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CredentialReleasedError,
  TOTP_MIN_REMAINING_MS,
  TotpStepUnavailableError,
  TotpSteps,
  freshTotpCode,
  holdCredential,
  totpStepAt,
  type Clock,
} from '../src/credentials';
import { TOTP_STEP_SECONDS, totpCode } from '../../../packages/portal/src/totp';

/** RFC 6238's own test key, "12345678901234567890", in canonical base32. */
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const STEP_MS = TOTP_STEP_SECONDS * 1000;
/** A moment a step begins. */
const STEP_START = Date.parse('2026-09-28T10:00:00Z');

/** A clock that moves only when slept on, or when a test moves it, and says how long each sleep was. */
function fakeClock(at: number): Clock & { slept: number[]; advance(ms: number): void } {
  let now = at;
  const slept: number[] = [];
  return {
    slept,
    now: () => now,
    sleep: async (ms) => {
      slept.push(ms);
      now += ms;
    },
    advance: (ms) => {
      now += ms;
    },
  };
}

const connection = () => ({ orgId: randomUUID(), connectionId: randomUUID() });

describe('freshTotpCode', () => {
  it('computes the current step\'s code at once while five seconds or more of it are left', async () => {
    const clock = fakeClock(STEP_START + STEP_MS - TOTP_MIN_REMAINING_MS);
    expect(await freshTotpCode(() => SECRET, clock, new TotpSteps().of(connection()))).toBe(totpCode(SECRET, STEP_START));
    expect(clock.slept).toEqual([]);
  });

  it('waits out a step with less left, and computes the next step\'s code', async () => {
    const clock = fakeClock(STEP_START + STEP_MS - TOTP_MIN_REMAINING_MS + 1);
    const code = await freshTotpCode(() => SECRET, clock, new TotpSteps().of(connection()));
    expect(clock.slept).toEqual([TOTP_MIN_REMAINING_MS - 1 + 50]);
    expect(code).toBe(totpCode(SECRET, STEP_START + STEP_MS));
    expect(code).not.toBe(totpCode(SECRET, STEP_START));
  });

  it('gives up, by name, on a clock that goes back every time it is waited on', async () => {
    let now = STEP_START + 1_000;
    const steps = new TotpSteps().of(connection());
    steps.typed(totpStepAt(now));
    const backwards: Clock = { now: () => now, sleep: async () => { now -= 1_000; } };
    await expect(freshTotpCode(() => SECRET, backwards, steps)).rejects.toThrow(TotpStepUnavailableError);
  });
});

describe('one code per step per connection (RFC 6238 §5.2)', () => {
  it('makes a second sign-in for the same connection within one step wait for the next step, and type its code', async () => {
    const ledger = new TotpSteps();
    const owner = connection();
    const clock = fakeClock(STEP_START + 1_000);

    const first = await freshTotpCode(() => SECRET, clock, ledger.of(owner));
    expect(first).toBe(totpCode(SECRET, STEP_START));
    expect(clock.slept).toEqual([]);

    // Twelve seconds later, well inside the same step: the same code would be typed twice.
    clock.advance(12_000);
    const second = await freshTotpCode(() => SECRET, clock, ledger.of(owner));
    expect(clock.slept).toEqual([STEP_MS - 13_000 + 50]);
    expect(second).toBe(totpCode(SECRET, STEP_START + STEP_MS));
    expect(second).not.toBe(first);

    // And a third, at once, waits for the step after that.
    const third = await freshTotpCode(() => SECRET, clock, ledger.of(owner));
    expect(third).toBe(totpCode(SECRET, STEP_START + 2 * STEP_MS));
    expect(new Set([first, second, third]).size).toBe(3);
  });

  it('makes no connection wait for another\'s code', async () => {
    const ledger = new TotpSteps();
    const clock = fakeClock(STEP_START + 1_000);
    const a = await freshTotpCode(() => SECRET, clock, ledger.of(connection()));
    clock.advance(12_000);
    const b = await freshTotpCode(() => SECRET, clock, ledger.of(connection()));
    expect(clock.slept).toEqual([]);
    // The same secret in the same step: the same code, typed for two different connections.
    expect(b).toBe(a);
  });

  it('tells the same connection apart by tenant as well as by id', async () => {
    const ledger = new TotpSteps();
    const clock = fakeClock(STEP_START + 1_000);
    const connectionId = randomUUID();
    await freshTotpCode(() => SECRET, clock, ledger.of({ orgId: randomUUID(), connectionId }));
    await freshTotpCode(() => SECRET, clock, ledger.of({ orgId: randomUUID(), connectionId }));
    expect(clock.slept).toEqual([]);
  });

  it('waits no longer once the step it last typed in has passed, and forgets steps that have', async () => {
    const ledger = new TotpSteps();
    const owner = connection();
    const clock = fakeClock(STEP_START + 1_000);
    await freshTotpCode(() => SECRET, clock, ledger.of(owner));
    await freshTotpCode(() => SECRET, clock, ledger.of(connection()));
    expect(ledger.size()).toBe(2);

    clock.advance(STEP_MS);
    expect(await freshTotpCode(() => SECRET, clock, ledger.of(owner))).toBe(totpCode(SECRET, STEP_START + STEP_MS));
    expect(clock.slept).toEqual([]);
    // The other connection's step has passed and can make nothing wait: it is gone.
    expect(ledger.size()).toBe(1);
  });

  it('records a step only for a code it computed: a run released while it waited burns none', async () => {
    const ledger = new TotpSteps();
    const owner = connection();
    const clock = fakeClock(STEP_START + STEP_MS - 1_000);
    await expect(freshTotpCode(() => { throw new CredentialReleasedError(); }, clock, ledger.of(owner))).rejects.toThrow(CredentialReleasedError);
    expect(ledger.of(owner).last()).toBeUndefined();
  });

  it('never lets two calls for one connection that wait together take the same step', async () => {
    const ledger = new TotpSteps();
    const owner = connection();
    // Too little of this step is left, so both calls wait for the next one.
    let now = STEP_START + STEP_MS - 1_000;
    const sleepers: (() => void)[] = [];
    const clock: Clock = { now: () => now, sleep: () => new Promise<void>((resolve) => { sleepers.push(resolve); }) };
    const flush = () => new Promise((resolve) => setImmediate(resolve));

    const a = freshTotpCode(() => SECRET, clock, ledger.of(owner));
    const b = freshTotpCode(() => SECRET, clock, ledger.of(owner));
    expect(sleepers).toHaveLength(2);

    // Both wake together in the next step: the first takes it, and the other waits for the step after.
    now = STEP_START + STEP_MS + 50;
    for (const wake of sleepers.splice(0)) wake();
    await flush();
    expect(sleepers).toHaveLength(1);
    now = STEP_START + 2 * STEP_MS + 50;
    for (const wake of sleepers.splice(0)) wake();

    expect(await Promise.all([a, b])).toEqual([totpCode(SECRET, STEP_START + STEP_MS), totpCode(SECRET, STEP_START + 2 * STEP_MS)]);
  });
});

describe('holdCredential', () => {
  const payload = { username: 'svc.reader@acme.test', password: 'pw-held', totpSecret: SECRET };

  it('answers the runner while the run holds it, and nothing once released', async () => {
    const held = holdCredential(payload, fakeClock(STEP_START), new TotpSteps().of(connection()));
    expect(held.source.username()).toBe(payload.username);
    expect(held.source.password()).toBe(payload.password);
    expect(await held.source.totp?.()).toBe(totpCode(SECRET, STEP_START));
    held.release();
    expect(() => held.source.username()).toThrow(CredentialReleasedError);
    expect(() => held.source.password()).toThrow(CredentialReleasedError);
    expect(() => held.username()).toThrow(CredentialReleasedError);
    await expect(Promise.resolve().then(() => held.source.totp?.())).rejects.toThrow(CredentialReleasedError);
  });

  it('refuses a code at once once released, without waiting for a step it could have used', async () => {
    const ledger = new TotpSteps();
    const owner = connection();
    const clock = fakeClock(STEP_START + 1_000);
    const held = holdCredential(payload, clock, ledger.of(owner));
    await held.source.totp?.();
    held.release();
    // The step is used, so a live credential would wait for the next one; a released one does not wait at all.
    await expect(Promise.resolve().then(() => held.source.totp?.())).rejects.toThrow(CredentialReleasedError);
    expect(clock.slept).toEqual([]);
  });

  it('asks for the TOTP secret only after any wait, so a run released meanwhile computes no code', async () => {
    const clock = fakeClock(STEP_START + STEP_MS - 1_000);
    let held: ReturnType<typeof holdCredential> | undefined;
    held = holdCredential(payload, { now: clock.now, sleep: async (ms) => { await clock.sleep(ms); held?.release(); } }, new TotpSteps().of(connection()));
    await expect(Promise.resolve().then(() => held?.source.totp?.())).rejects.toThrow(CredentialReleasedError);
  });

  it('types a new code for each run of the same connection, through the ledger it is given', async () => {
    const ledger = new TotpSteps();
    const owner = connection();
    const clock = fakeClock(STEP_START + 1_000);
    const first = holdCredential(payload, clock, ledger.of(owner));
    const firstCode = await first.source.totp?.();
    first.release();
    const second = holdCredential(payload, clock, ledger.of(owner));
    expect(await second.source.totp?.()).not.toBe(firstCode);
  });

  it('has no TOTP when none was sealed', () => {
    expect(holdCredential({ username: payload.username, password: payload.password }, fakeClock(STEP_START), new TotpSteps().of(connection())).source.totp).toBeUndefined();
  });

  it('never names a value in what it throws', () => {
    const held = holdCredential(payload, fakeClock(STEP_START), new TotpSteps().of(connection()));
    held.release();
    try {
      held.source.password();
    } catch (e) {
      expect(String(e)).not.toContain(payload.password);
      expect(String(e)).not.toContain(payload.username);
      return;
    }
    throw new Error('a released credential answered');
  });
});
