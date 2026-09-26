import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closeAllPools, PostgresStore, sessionPool } from '../src/store';

/**
 * The two questions a job asks the database, against the real schema.
 *
 * Both are load-bearing: one is the check that stops a signed event from having
 * a document read on behalf of somebody who is not a member (ADR 0021), and the
 * other is what tells a redelivered event that the document it names has
 * already been read and where that read landed. Neither can be trusted to an
 * in-memory store — a typo in either query would look exactly like a refusal,
 * or like a document nobody has read.
 *
 * They live on `PostgresStore` beside every other query, so both run inside the
 * one `withTenant` — `set local role app_rw` plus the tenant's claims set
 * transaction-locally, on the shared pool, with no service-role key anywhere
 * near them (invariant 6). They used to live in a subclass in `apps/web`, which
 * meant a second copy of that transaction discipline for the app to keep in
 * step; these assertions came with them unchanged.
 *
 * `pnpm db:test` prepares the database; without TEST_DATABASE_URL there is nothing
 * to test against and these skip themselves.
 */
const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

describeDb('the two questions a job asks the database', () => {
  const admin = sessionPool({ connectionString: connectionString as string });
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const analystId = randomUUID();
  const readerId = randomUUID();
  const outsiderId = randomUUID();
  const suffix = orgId.slice(0, 8);

  const storeFor = (tenant: { orgId: string; userId: string }): PostgresStore =>
    new PostgresStore({ connectionString: connectionString as string }, tenant);

  let store: PostgresStore;
  let documentId: string;
  let noticeCaseId: string;

  beforeAll(async () => {
    await admin.query(
      `insert into organizations (id, slug, name) values ($1,$2,'Jobs'), ($3,$4,'Jobs Other')`,
      [orgId, `jobs-${suffix}`, otherOrgId, `jobs-other-${suffix}`],
    );
    await admin.query('insert into org_settings (org_id) values ($1), ($2)', [orgId, otherOrgId]);
    await admin.query('insert into users (id, email) values ($1,$2), ($3,$4), ($5,$6)', [
      analystId,
      `analyst-${suffix}@example.test`,
      readerId,
      `reader-${suffix}@example.test`,
      outsiderId,
      `outsider-${suffix}@example.test`,
    ]);
    await admin.query(
      `insert into memberships (org_id, user_id, role)
       values ($1,$2,'analyst'), ($1,$3,'read_only'), ($4,$5,'analyst')`,
      [orgId, analystId, readerId, otherOrgId, outsiderId],
    );

    store = storeFor({ orgId, userId: analystId });
    const stored = await store.putDocument({
      orgId,
      sha256: randomUUID().replace(/-/g, '').padEnd(64, '0'),
      filename: 'notice.pdf',
      mimeType: 'application/pdf',
      byteSize: 4,
      bytes: new Uint8Array([1, 2, 3, 4]),
      requiresSplit: false,
    });
    documentId = stored.documentId;

    // Evidence on one case, the notice on another, and the notice link is the
    // one this document's read belongs to.
    const evidenceCase = await store.openCase({ orgId, claimId: `EV-${suffix}` });
    await store.linkDocument(evidenceCase.deductionId, documentId, 'evidence');
    const noticeCase = await store.openCase({ orgId, claimId: `NOTICE-${suffix}` });
    noticeCaseId = noticeCase.deductionId;
    await store.linkDocument(noticeCaseId, documentId, 'notice');
  });

  afterAll(async () => {
    await closeAllPools();
  });

  it('says a writer may write, and a reader may not', async () => {
    await expect(store.memberMayWrite({ orgId, userId: analystId })).resolves.toBe(true);

    const reader = storeFor({ orgId, userId: readerId });
    await expect(reader.memberMayWrite({ orgId, userId: readerId })).resolves.toBe(false);
  });

  it('says no to somebody who is not a member of this org at all', async () => {
    // The hole this closes: `tenant_read` is the org claim and nothing else, so
    // an event pairing this org with a member of another one would otherwise
    // read — and pay for — a document that is not theirs.
    const outsider = storeFor({ orgId, userId: outsiderId });
    await expect(outsider.memberMayWrite({ orgId, userId: outsiderId })).resolves.toBe(false);

    // And a user id that belongs to nobody at all.
    const strangerId = randomUUID();
    const nobody = storeFor({ orgId, userId: strangerId });
    await expect(nobody.memberMayWrite({ orgId, userId: strangerId })).resolves.toBe(false);
  });

  it('refuses to answer for a member it is not acting as', async () => {
    // The claims are what `app.member_may_write()` reads. Answering for anyone
    // else would be answering a different question than the one asked, and a
    // `false` would look like a refused member rather than a bug.
    await expect(store.memberMayWrite({ orgId, userId: readerId })).rejects.toThrow(
      /different member/,
    );
    await expect(store.memberMayWrite({ orgId: otherOrgId, userId: analystId })).rejects.toThrow(
      /different member/,
    );
  });

  it('finds the case a document was filed against, the notice link first', async () => {
    await expect(store.caseForDocument(documentId)).resolves.toBe(noticeCaseId);
  });

  it('finds nothing for a document this tenant cannot see', async () => {
    // RLS, not a filter this query remembered: the other tenant's store reads
    // the same row by the same id and gets nothing.
    const other = storeFor({ orgId: otherOrgId, userId: outsiderId });
    await expect(other.caseForDocument(documentId)).resolves.toBeUndefined();
    await expect(store.caseForDocument(randomUUID())).resolves.toBeUndefined();
  });
});
