// The one place a portal credential is in the clear (ADR 0057 §6-7): opened by
// the worker, for the binding of the recipe it is about to run, and held for
// that run and no longer. The runner asks for each value as it types it into a
// bound form. Once the run ends the source is released, and asking it again
// throws rather than answering.
//
// No value read here reaches an error message, a log line or a result. A
// payload that will not parse is refused by name. `JSON.parse`'s own message
// quotes what it could not read, which here would be the plaintext.
import type { TokenCipher } from '@recouple/crypto';
import {
  PortalCredentialPayloadSchema,
  TOTP_STEP_SECONDS,
  portalCredentialContext,
  totpCode,
  totpStepRemainingMs,
  type CredentialSource,
  type PortalBinding,
  type PortalCredentialPayload,
  type RunRequest,
} from './portal';

/**
 * How long a TOTP code must stay current once it is computed. A step with less
 * left is waited out, so the code the portal checks is never one that expired
 * on the way. A code refused as stale would read as a refused credential, and
 * that turns the connection off (ADR 0057 §8).
 */
export const TOTP_MIN_REMAINING_MS = 5_000;
/** How far into the next step a waited-out code is computed. */
const TOTP_STEP_MARGIN_MS = 50;
const TOTP_STEP_MS = TOTP_STEP_SECONDS * 1000;
/**
 * How many times a code may be waited for before the clock is given up on.
 * One wait always suffices on a clock that moves forward; the rest are for one
 * that was set back while it waited.
 */
const TOTP_MAX_WAITS = 3;

/** The sealed credential opened, but it is not a portal credential payload. Named, never quoted. */
export class PortalCredentialPayloadError extends Error {
  override readonly name = 'PortalCredentialPayloadError';
  constructor() {
    super('the sealed credential did not open to a portal credential payload');
  }
}

/** A value was asked of a credential source after its run ended. */
export class CredentialReleasedError extends Error {
  override readonly name = 'CredentialReleasedError';
  constructor() {
    super('a portal credential was asked for after its run ended');
  }
}

/** No TOTP step could be reached that no code had been typed in: the clock kept going back. */
export class TotpStepUnavailableError extends Error {
  override readonly name = 'TotpStepUnavailableError';
  constructor() {
    super('no fresh TOTP step was reached; the clock did not move forward');
  }
}

export interface Clock {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

/** The TOTP step, RFC 6238's T, a code computed at `atMs` belongs to. */
export function totpStepAt(atMs: number): number {
  return Math.floor(atMs / TOTP_STEP_MS);
}

/**
 * The TOTP step each connection last computed a code for, in this worker's
 * memory, so a code is never typed twice (RFC 6238 §5.2: a verifier refuses a
 * code used once). Two sign-ins for one connection whose MFA forms come within
 * one 30-second step would otherwise type the same code, and a portal that
 * refuses the second reads to the runner as a refused credential, which turns
 * the connection off (ADR 0057 §8) and counts a failed MFA attempt against the
 * dedicated user.
 *
 * It holds the tenant's and the connection's ids and a step number, and
 * nothing derived from any secret. A step behind the clock can never make a
 * code wait, so entries for steps that have passed are dropped as others are
 * written. It is forgotten when the worker restarts.
 */
export class TotpSteps {
  private readonly last = new Map<string, number>();

  /** The ledger's view of one connection, for one run's credential. */
  of(owner: { readonly orgId: string; readonly connectionId: string }): TotpStepRecord {
    const key = `${owner.orgId}/${owner.connectionId}`;
    return {
      last: () => this.last.get(key),
      typed: (step) => {
        for (const [other, used] of this.last) {
          if (used < step) this.last.delete(other);
        }
        this.last.set(key, Math.max(step, this.last.get(key) ?? step));
      },
    };
  }

  /** How many connections have a step recorded. */
  size(): number {
    return this.last.size;
  }
}

/** One connection's entry in `TotpSteps`. */
export interface TotpStepRecord {
  /** The step of the last code computed for this connection, if one is still current or ahead. */
  last(): number | undefined;
  /** Records that a code for `step` was computed for this connection. */
  typed(step: number): void;
}

/**
 * Opens the run's sealed credential under the encryption context of its
 * tenant, its connection and `binding`, which is the binding of the recipe
 * about to run. A credential sealed for anything else does not open.
 */
export async function openCredential(
  request: Pick<RunRequest, 'orgId' | 'connectionId' | 'sealed'>,
  binding: PortalBinding,
  cipher: TokenCipher,
): Promise<PortalCredentialPayload> {
  const context = portalCredentialContext({ orgId: request.orgId, connectionId: request.connectionId }, binding);
  return parsePayload(await cipher.decrypt(request.sealed, context));
}

function parsePayload(plaintext: string): PortalCredentialPayload {
  let json: unknown;
  try {
    json = JSON.parse(plaintext);
  } catch {
    // The parser's message quotes the input: it is replaced, not passed on.
    throw new PortalCredentialPayloadError();
  }
  const parsed = PortalCredentialPayloadSchema.safeParse(json);
  if (!parsed.success) throw new PortalCredentialPayloadError();
  return parsed.data;
}

export interface HeldCredential {
  /** What the runner types. */
  readonly source: CredentialSource;
  /** The username, for replacing it in what the run captured, while the credential is held. */
  username(): string;
  /** Lets go of the payload. Every value asked for after this throws `CredentialReleasedError`. */
  release(): void;
}

/**
 * A credential source over `payload`, for one run. `totp` is there only when a
 * TOTP secret was sealed. Without one, the runner ends an `answer_mfa` step
 * `mfa_unanswerable`. `steps` is this connection's entry in the worker's
 * `TotpSteps`, so no code this run types is one an earlier run typed.
 */
export function holdCredential(payload: PortalCredentialPayload, clock: Clock, steps: TotpStepRecord): HeldCredential {
  let held: PortalCredentialPayload | undefined = payload;
  const live = (): PortalCredentialPayload => {
    if (held === undefined) throw new CredentialReleasedError();
    return held;
  };
  const secret = (): string => {
    const value = live().totpSecret;
    if (value === undefined) throw new CredentialReleasedError();
    return value;
  };
  const source: CredentialSource = {
    username: () => live().username,
    password: () => live().password,
    ...(payload.totpSecret === undefined
      ? {}
      : {
          // Released already: refused at once, not after waiting for a step.
          totp: async () => {
            live();
            return freshTotpCode(secret, clock, steps);
          },
        }),
  };
  return {
    source,
    username: () => live().username,
    release: () => {
      held = undefined;
    },
  };
}

/**
 * The code for now, computed as it is about to be typed, in a step no code for
 * this connection was computed in before (`steps`) and with at least
 * `TOTP_MIN_REMAINING_MS` of it left. Otherwise the next step that is both is
 * waited for: at most one step and a little over 30 seconds, which the runner
 * waits for before it fills the MFA form. The secret is asked for only after
 * the wait, so a run released meanwhile computes nothing, and the step is
 * recorded in the same turn as the code is computed, so no two calls can take
 * one step.
 */
export async function freshTotpCode(secret: () => string, clock: Clock, steps: TotpStepRecord): Promise<string> {
  for (let waits = 0; ; waits++) {
    const now = clock.now();
    const step = totpStepAt(now);
    const last = steps.last();
    if ((last === undefined || step > last) && totpStepRemainingMs(now) >= TOTP_MIN_REMAINING_MS) {
      const code = totpCode(secret(), now);
      steps.typed(step);
      return code;
    }
    if (waits >= TOTP_MAX_WAITS) throw new TotpStepUnavailableError();
    // The step after both the one now and the one used last.
    const next = Math.max(step, last ?? step) + 1;
    await clock.sleep(next * TOTP_STEP_MS - now + TOTP_STEP_MARGIN_MS);
  }
}
