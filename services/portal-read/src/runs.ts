// The runs a worker holds (ADR 0057 §6, the contract's worker routes): at most
// one in flight, since a run is a browser and a signed-in session, and each
// finished run's result and captures for `ttlMs`, after which they are
// forgotten. A forgotten run keeps its id, owner and state, so the same id is
// never started twice: a retried job step cannot sign in a second time, even
// after the result it would have fetched is gone. Nothing here outlives the
// process. A worker that restarted holds nothing.
//
// The captures' bytes are bounded as well as their time. Past `maxHeldBytes`
// in all, the bytes of other finished runs are let go to make room for a new
// run's, oldest first and those whose every capture was fetched before any
// that was not, and the run keeps its result. A capture let go answers as one
// the worker does not hold, as a forgotten run's does, and the job records the
// run failed rather than starting it again.
import type { HeldCapture } from './capture';
import type { RunResult } from './portal';

/** Whose run it is: the request's tenant and connection, which a retried request must name again. */
export interface RunOwner {
  readonly runId: string;
  readonly orgId: string;
  readonly connectionId: string;
}

export type HeldRun =
  | (RunOwner & { readonly state: 'running' })
  | (RunOwner & {
      readonly state: 'done';
      readonly result: RunResult;
      /** Empty once let go to make room (`capturesLetGo`), whatever the result lists. */
      readonly captures: readonly HeldCapture[];
      readonly capturesLetGo: boolean;
      readonly endedAt: number;
    })
  | (RunOwner & { readonly state: 'forgotten' });

type DoneRun = Extract<HeldRun, { state: 'done' }>;

export interface RunRegistryOptions {
  readonly now: () => number;
  /** How long a finished run's result and captures stay fetchable. */
  readonly ttlMs: number;
  /** How many forgotten runs' ids are kept, the oldest dropped first. */
  readonly maxForgotten: number;
  /** The most capture bytes held across every finished run. */
  readonly maxHeldBytes: number;
}

export type HeldCaptureLookup =
  | { readonly found: true; readonly capture: HeldCapture }
  | { readonly found: false; readonly why: 'unknown' | 'running' | 'not_held' };

export class RunRegistry {
  private readonly runs = new Map<string, HeldRun>();
  /** Each finished run's captures fetched at least once, by index. */
  private readonly fetched = new Map<string, Set<number>>();
  private inFlight: string | null = null;
  private held = 0;

  constructor(private readonly options: RunRegistryOptions) {}

  /** The run, if this worker holds it. Anything past its time is forgotten first. */
  get(runId: string): HeldRun | undefined {
    this.sweep();
    return this.runs.get(runId);
  }

  /** The run in flight, whose browser may still be open, if any. */
  active(): string | null {
    return this.inFlight;
  }

  /** The capture bytes held now, across every finished run. */
  heldBytes(): number {
    return this.held;
  }

  /** Starts holding a run as the one in flight. False, and nothing held, while another is in flight or the id is known. */
  begin(owner: RunOwner): boolean {
    if (this.inFlight !== null || this.runs.has(owner.runId)) return false;
    this.runs.set(owner.runId, { ...owner, state: 'running' });
    this.inFlight = owner.runId;
    return true;
  }

  /** Holds a run that ended before it started: refused before anything was decrypted. False when the id is known. */
  endedBeforeStart(owner: RunOwner, result: RunResult): boolean {
    if (this.runs.has(owner.runId)) return false;
    this.runs.set(owner.runId, this.done(owner, result, []));
    return true;
  }

  /**
   * A running run's end. A run that has already ended keeps its first end.
   * Returns the ids of the runs whose captures were let go to make room.
   */
  end(runId: string, result: RunResult, captures: readonly HeldCapture[]): string[] {
    const run = this.runs.get(runId);
    if (run === undefined || run.state !== 'running') return [];
    this.runs.set(runId, this.done(run, result, captures));
    this.held += bytesOf(captures);
    return this.makeRoom(runId);
  }

  /** The run's browser has closed: another run may start. */
  release(runId: string): void {
    if (this.inFlight === runId) this.inFlight = null;
  }

  /** One capture of a finished run, or why there is none to send. */
  capture(runId: string, index: number): HeldCaptureLookup {
    const run = this.get(runId);
    if (run === undefined || run.state === 'forgotten') return { found: false, why: 'unknown' };
    if (run.state === 'running') return { found: false, why: 'running' };
    const capture = run.captures[index];
    return capture === undefined ? { found: false, why: 'not_held' } : { found: true, capture };
  }

  /** A capture was sent in full, so its job holds it: of the captures held, those fetched in full are let go first. */
  fetchedInFull(runId: string, index: number): void {
    this.fetched.get(runId)?.add(index);
  }

  /** Forgets every result past its time, then drops the oldest forgotten ids past the cap. */
  sweep(): void {
    const now = this.options.now();
    let forgotten = 0;
    for (const [runId, run] of this.runs) {
      if (run.state === 'done' && now - run.endedAt >= this.options.ttlMs) this.forget(run);
      if (this.runs.get(runId)?.state === 'forgotten') forgotten++;
    }
    // A Map iterates in the order its keys were first set: the oldest run first.
    for (const [runId, run] of this.runs) {
      if (forgotten <= this.options.maxForgotten) break;
      if (run.state === 'forgotten') {
        this.runs.delete(runId);
        forgotten--;
      }
    }
  }

  private done(owner: RunOwner, result: RunResult, captures: readonly HeldCapture[]): DoneRun {
    this.fetched.set(owner.runId, new Set());
    return {
      runId: owner.runId,
      orgId: owner.orgId,
      connectionId: owner.connectionId,
      state: 'done',
      result,
      captures,
      capturesLetGo: false,
      endedAt: this.options.now(),
    };
  }

  private forget(run: DoneRun): void {
    if (!run.capturesLetGo) this.held -= bytesOf(run.captures);
    this.fetched.delete(run.runId);
    this.runs.set(run.runId, { runId: run.runId, orgId: run.orgId, connectionId: run.connectionId, state: 'forgotten' });
  }

  /** Lets go of other finished runs' captures until what is held fits, those fetched in full first, then the oldest. */
  private makeRoom(keep: string): string[] {
    const letGo: string[] = [];
    while (this.held > this.options.maxHeldBytes) {
      const candidates = [...this.runs.values()].filter(
        (run): run is DoneRun => run.state === 'done' && run.runId !== keep && !run.capturesLetGo && run.captures.length > 0,
      );
      if (candidates.length === 0) break;
      const fetchedInFull = (run: DoneRun): boolean => (this.fetched.get(run.runId)?.size ?? 0) === run.captures.length;
      candidates.sort((a, b) => Number(fetchedInFull(b)) - Number(fetchedInFull(a)) || a.endedAt - b.endedAt);
      const oldest = candidates[0]!;
      this.held -= bytesOf(oldest.captures);
      this.runs.set(oldest.runId, { ...oldest, captures: [], capturesLetGo: true });
      letGo.push(oldest.runId);
    }
    return letGo;
  }
}

function bytesOf(captures: readonly HeldCapture[]): number {
  return captures.reduce((sum, c) => sum + c.bytes.byteLength, 0);
}
