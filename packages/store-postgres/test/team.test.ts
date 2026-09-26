import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgresTeamStore, TeamChangeRefusedError } from '../src/team';
import { addressIsInvited } from '../src/session';
import { closeAllPools } from '../src/store';

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

/**
 * Settings → Team's store against a real database (ADR 0051, migration 0035).
 *
 * Suite 31 asks the functions their questions in SQL. This asks the ones only
 * the driver answers: are the claims this store sets the ones the functions
 * read, does every refusal arrive as a named `TeamChangeRefusedError` rather
 * than a driver string, and does the list read what RLS lets a member see.
 */
describeDb('Settings → Team on Postgres', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const ownerId = randomUUID();
  const analystId = randomUUID();
  const readerId = randomUUID();
  const otherOwnerId = randomUUID();
  const suffix = orgId.slice(0, 8);
  const config = { connectionString: connectionString as string };

  let owner: PostgresTeamStore;
  let analyst: PostgresTeamStore;
  let reader: PostgresTeamStore;
  let other: PostgresTeamStore;

  beforeAll(async () => {
    await admin.query(
      `insert into organizations (id, slug, name) values ($1,$2,'Team'), ($3,$4,'Team Other')`,
      [orgId, `team-${suffix}`, otherOrgId, `team-other-${suffix}`],
    );
    await admin.query(`insert into org_settings (org_id) values ($1), ($2)`, [orgId, otherOrgId]);
    await admin.query(
      `insert into users (id, email, full_name, auth_user_id)
       values ($1,$2,'Owner',gen_random_uuid()), ($3,$4,null,null), ($5,$6,'Reader',null), ($7,$8,'Other',null)`,
      [
        ownerId, `team-o-${suffix}@example.test`,
        analystId, `team-a-${suffix}@example.test`,
        readerId, `team-r-${suffix}@example.test`,
        otherOwnerId, `team-x-${suffix}@example.test`,
      ],
    );
    await admin.query(
      `insert into memberships (org_id, user_id, role)
       values ($1,$2,'owner'), ($1,$3,'analyst'), ($1,$4,'read_only'), ($5,$6,'owner')`,
      [orgId, ownerId, analystId, readerId, otherOrgId, otherOwnerId],
    );
    owner = new PostgresTeamStore(config, { orgId, userId: ownerId });
    analyst = new PostgresTeamStore(config, { orgId, userId: analystId });
    reader = new PostgresTeamStore(config, { orgId, userId: readerId });
    other = new PostgresTeamStore(config, { orgId: otherOrgId, userId: otherOwnerId });
  });

  afterAll(async () => {
    await admin.end();
    await closeAllPools();
  });

  async function refusal(promise: Promise<unknown>): Promise<string> {
    const error = await promise.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(TeamChangeRefusedError);
    return (error as TeamChangeRefusedError).refusal;
  }

  it('lists the workspace to every member, owners first, and nobody else’s', async () => {
    const seen = await reader.members();
    expect(seen.map((member) => [member.role, member.email, member.hasSignedIn])).toEqual([
      ['owner', `team-o-${suffix}@example.test`, true],
      ['analyst', `team-a-${suffix}@example.test`, false],
      ['read_only', `team-r-${suffix}@example.test`, false],
    ]);
    expect(seen.find((member) => member.userId === analystId)?.fullName).toBeUndefined();
    expect((await other.members()).map((member) => member.userId)).toEqual([otherOwnerId]);
  });

  it('invites as the owner, reusing a row that differs only in capitals', async () => {
    const invited = await owner.invite({
      email: `Team-X-${suffix}@Example.Test`,
      fullName: 'Ignored',
      role: 'approver',
    });
    expect(invited).toEqual({ userId: otherOwnerId, usersRowCreated: false });
    // The list shows the name this owner typed, not the one the other workspace stored.
    const listed = (await owner.members()).find((member) => member.userId === otherOwnerId);
    expect(listed?.fullName).toBe('Ignored');

    // Another workspace's stored name never shows here, even when this owner typed none.
    const storedElsewhere = randomUUID();
    await admin.query(`insert into users (id, email, full_name) values ($1, $2, 'Stored Elsewhere')`, [
      storedElsewhere,
      `stored-${suffix}@example.test`,
    ]);
    await admin.query(`insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')`, [
      otherOrgId,
      storedElsewhere,
    ]);
    await owner.invite({ email: `stored-${suffix}@example.test`, fullName: '  ', role: 'read_only' });
    const blank = (await owner.members()).find((member) => member.userId === storedElsewhere);
    expect(blank?.email).toBe(`stored-${suffix}@example.test`);
    expect(blank?.fullName).toBeUndefined();
    expect((await other.members()).find((member) => member.userId === storedElsewhere)?.fullName).toBe(
      'Stored Elsewhere',
    );

    const fresh = await owner.invite({ email: `new-${suffix}@example.test`, fullName: 'New', role: 'analyst' });
    expect(fresh.usersRowCreated).toBe(true);

    const { rows } = await admin.query<{ n: string }>(
      `select count(*) as n from audit_log where org_id = $1 and action = 'membership.invited' and actor_id = $2`,
      [orgId, ownerId],
    );
    // Three invitations above: the reused row, the stored-elsewhere row, a new one.
    expect(Number(rows[0]?.n)).toBe(3);
  });

  it('names every refusal', async () => {
    expect(await refusal(analyst.invite({ email: `z-${suffix}@example.test`, fullName: '', role: 'owner' }))).toBe(
      'not_owner',
    );
    expect(await refusal(reader.remove(analystId))).toBe('not_owner');
    expect(await refusal(owner.invite({ email: `team-a-${suffix}@example.test`, fullName: '', role: 'analyst' }))).toBe(
      'already_member',
    );
    expect(await refusal(owner.invite({ email: 'nope', fullName: '', role: 'analyst' }))).toBe('invalid');
    expect(await refusal(owner.changeRole(ownerId, 'approver'))).toBe('last_owner');
    expect(await refusal(owner.remove(ownerId))).toBe('last_owner');
    expect(await refusal(owner.remove(randomUUID()))).toBe('not_member');
    expect(await refusal(other.remove(analystId))).toBe('not_member');

    await admin.query(
      `insert into accounting_connections (org_id, provider, provider_account_id, created_by)
       values ($1, 'qbo', $2, $3)`,
      [orgId, `realm-team-${suffix}`, ownerId],
    );
    await owner.changeRole(analystId, 'owner');
    expect(await refusal(owner.changeRole(ownerId, 'approver'))).toBe('holds_ledger');
    await admin.query(`update accounting_connections set enabled = false where org_id = $1`, [orgId]);
  });

  it('changes a role and removes a member, and returns what they were', async () => {
    expect(await owner.changeRole(readerId, 'accountant_guest')).toBe('read_only');
    expect(await owner.remove(readerId)).toBe('accountant_guest');
    expect((await owner.members()).some((member) => member.userId === readerId)).toBe(false);
    const { rows } = await admin.query<{ n: string }>(`select count(*) as n from users where id = $1`, [readerId]);
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it('answers the sign-in form’s question with no claims, one bit per address', async () => {
    expect(await addressIsInvited(config, `TEAM-A-${suffix}@example.test`)).toBe(true);
    expect(await addressIsInvited(config, `nobody-${suffix}@example.test`)).toBe(false);
    // Signed in already (auth_user_id set): their account exists, so it is not an invitation.
    expect(await addressIsInvited(config, `team-o-${suffix}@example.test`)).toBe(false);
    // Removed above from their only workspace: no longer an invitation.
    expect(await addressIsInvited(config, `team-r-${suffix}@example.test`)).toBe(false);
  });
});
