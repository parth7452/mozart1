import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { closeAllPools, PostgresStore } from '../src/store';

/**
 * The claim that makes two overlapping reads of one document into one read.
 *
 * `readDocumentJob`'s guard asks the database whether a document has already
 * been read, and then reads it — and the whole read sits between the question
 * and the answer changing. Two deliveries that overlap in that window both hear
 * "not read yet". The reviewer who found this ran two `readDocumentJob` calls
 * on one document and got four model calls, two `extraction_results` rows and
 * two cases, because `unique (org_id, debtor_id, claim_id)` does not fire while
 * `debtor_id` is null (ADR 0019).
 *
 * A flag in one process would not have helped: the two deliveries are two
 * invocations of a serverless function, on two machines. So the claim is in the
 * database, and this is the half of it a test in `packages/pipeline` cannot
 * prove — that it holds *between two connections*, which is what two machines
 * look like from here.
 *
 * `pnpm db:test` prepares the database; without `TEST_DATABASE_URL` there is nothing
 * to test against.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

describeDb('one document’s read, held in the database', () => {
  const orgId = randomUUID();
  const analystId = randomUUID();
  const otherOrgId = randomUUID();
  const outsiderId = randomUUID();
  const suffix = orgId.slice(0, 8);

  let admin: Pool;
  /** Two stores for the same tenant: two identities' worth of connections. */
  let one: PostgresStore;
  let two: PostgresStore;
  let otherTenant: PostgresStore;

  beforeAll(async () => {
    admin = new Pool({ connectionString: connectionString as string });
    await admin.query(
      `insert into organizations (id, slug, name) values ($1,$2,'Lock'), ($3,$4,'Lock Other')`,
      [orgId, `lock-${suffix}`, otherOrgId, `lock-other-${suffix}`],
    );
    await admin.query('insert into org_settings (org_id) values ($1), ($2)', [orgId, otherOrgId]);
    await admin.query('insert into users (id, email) values ($1,$2), ($3,$4)', [
      analystId,
      `lock-analyst-${suffix}@example.test`,
      outsiderId,
      `lock-outsider-${suffix}@example.test`,
    ]);
    await admin.query(
      `insert into memberships (org_id, user_id, role) values ($1,$2,'analyst'), ($3,$4,'analyst')`,
      [orgId, analystId, otherOrgId, outsiderId],
    );

    const tenant = { orgId, userId: analystId };
    one = new PostgresStore({ connectionString: connectionString as string }, tenant);
    two = new PostgresStore({ connectionString: connectionString as string }, tenant);
    otherTenant = new PostgresStore({ connectionString: connectionString as string }, {
      orgId: otherOrgId,
      userId: outsiderId,
    });
  });

  afterAll(async () => {
    await admin?.end();
    await closeAllPools();
  });

  it('lets one connection in and turns the other away, without waiting for it', async () => {
    const documentId = randomUUID();

    let insideTheFirst = (): void => undefined;
    const firstIsInside = new Promise<void>((resolve) => {
      insideTheFirst = resolve;
    });
    let letTheFirstFinish = (): void => undefined;
    const finish = new Promise<void>((resolve) => {
      letTheFirstFinish = resolve;
    });

    const held = one.withDocumentRead(documentId, async () => {
      insideTheFirst();
      await finish;
      return 'the read';
    });

    await firstIsInside;

    // The second connection, while the first one is inside. It is told, not
    // queued: a caller that waited would hold a worker for the length of
    // somebody else's model calls to learn something it can be told now.
    const before = Date.now();
    const refused = await two.withDocumentRead(documentId, async () => {
      throw new Error('this work must not run while another connection holds the document');
    });
    expect(refused).toEqual({ held: false });
    expect(Date.now() - before).toBeLessThan(2_000);

    letTheFirstFinish();
    expect(await held).toEqual({ held: true, result: 'the read' });

    // And once the first has committed, the claim is free again.
    const after = await two.withDocumentRead(documentId, async () => 'the second read');
    expect(after).toEqual({ held: true, result: 'the second read' });
  });

  it('releases the claim when the work throws', async () => {
    // A claim that outlived its holder would make one failed delivery enough to
    // seal a document shut for ever — and silently, which is worse than the
    // failure it guards against.
    const documentId = randomUUID();
    const boom = new Error('anthropic: 503');

    await expect(
      one.withDocumentRead(documentId, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(await two.withDocumentRead(documentId, async () => 'read after the failure')).toEqual({
      held: true,
      result: 'read after the failure',
    });
  });

  it('holds one document at a time, not one tenant at a time', async () => {
    // A tenant dropping two notices in at once reads both at once. Only the
    // same document twice is serialised.
    const first = randomUUID();
    const second = randomUUID();

    let releaseFirst = (): void => undefined;
    const firstHolds = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstIsIn = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      firstIsIn = resolve;
    });

    const holding = one.withDocumentRead(first, async () => {
      firstIsIn();
      await firstHolds;
      return 'first';
    });
    await entered;

    expect(await two.withDocumentRead(second, async () => 'second')).toEqual({
      held: true,
      result: 'second',
    });

    releaseFirst();
    await holding;
  });

  it('does not leave the claim on the connection it borrowed', async () => {
    // The reason this is a transaction-scoped lock rather than a session one:
    // `DATABASE_URL` is a transaction pooler, so a connection is reused by the
    // next caller and anything that outlives the transaction outlives the
    // tenant it was taken for. Run more reads than the pool has connections and
    // then ask again — a leak shows up as a refusal.
    const documentId = randomUUID();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      expect(await one.withDocumentRead(documentId, async () => attempt)).toEqual({
        held: true,
        result: attempt,
      });
    }
    expect(await two.withDocumentRead(documentId, async () => 'still free')).toEqual({
      held: true,
      result: 'still free',
    });
  });

  it('is one claim per document across tenants, because ids are not shared', async () => {
    // Two tenants never name the same document: the id is a UUID from our own
    // `documents` table, and RLS has already decided whose it is before this is
    // reached. What this asserts is the other half — that holding one tenant's
    // document does not hold another tenant's.
    const mine = randomUUID();
    const theirs = randomUUID();

    let release = (): void => undefined;
    const holds = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = (): void => undefined;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const holding = one.withDocumentRead(mine, async () => {
      entered();
      await holds;
      return 'mine';
    });
    await inside;

    expect(await otherTenant.withDocumentRead(theirs, async () => 'theirs')).toEqual({
      held: true,
      result: 'theirs',
    });

    release();
    await holding;
  });
});
