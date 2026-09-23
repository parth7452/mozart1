/**
 * A `QboTokenStore` that keeps tokens in a Map.
 *
 * It lives under `@recouple/qbo/testing` and is not re-exported from the
 * package root, for the same reason `@recouple/pipeline/testing` is kept apart:
 * a fixture reachable from production is a fixture that will eventually run
 * there. Real tokens belong in KMS-backed storage, never in an application
 * table and never in a process's heap across a deploy (ADR 0026).
 */

import type { QboTokenStore, QboTokens } from '../tokens';

export class InMemoryQboTokenStore implements QboTokenStore {
  private readonly byRealm = new Map<string, QboTokens>();

  /**
   * Every `save`, in order. A test asserting that the rotated refresh token was
   * persisted *before* the next API call needs to see when the save happened,
   * not only what it left behind.
   */
  readonly saves: Array<{ readonly realmId: string; readonly tokens: QboTokens }> = [];

  constructor(seed?: Readonly<Record<string, QboTokens>>) {
    for (const [realmId, tokens] of Object.entries(seed ?? {})) {
      this.byRealm.set(realmId, { ...tokens });
    }
  }

  async load(realmId: string): Promise<QboTokens | undefined> {
    const stored = this.byRealm.get(realmId);
    return stored === undefined ? undefined : { ...stored };
  }

  async save(realmId: string, tokens: QboTokens): Promise<void> {
    this.byRealm.set(realmId, { ...tokens });
    this.saves.push({ realmId, tokens: { ...tokens } });
  }

  /** The tail of each company's queue: the last holder's work, settled or not. */
  private readonly tails = new Map<string, Promise<unknown>>();

  /**
   * One holder per company at a time, in the order they asked — a promise
   * chain in one process, where the Postgres store's is an advisory lock in
   * the database. Same contract: the next holder starts after the last one's
   * work has finished, however it finished.
   */
  async withRefreshLock<T>(realmId: string, work: () => Promise<T>): Promise<T> {
    const before = this.tails.get(realmId) ?? Promise.resolve();
    const mine = before.then(work, work);
    // The queue continues whether this holder succeeds or throws.
    this.tails.set(
      realmId,
      mine.then(
        () => undefined,
        () => undefined,
      ),
    );
    return mine;
  }
}
