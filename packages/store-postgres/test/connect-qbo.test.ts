import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { QboTokens } from '@recouple/qbo';
import type { TokenCipher } from '@recouple/crypto';
import { LocalTokenCipher } from '@recouple/crypto/testing';
import {
  AccountConnectedElsewhereError,
  listConnectionsToSync,
  OwnerRequiredError,
  PostgresLedgerSyncStore,
} from '../src/connections';
import {
  connectQboCompany,
  disconnectLedger,
  planLedgerClaim,
  releaseDeadLedger,
} from '../src/connect-qbo';
import { LedgerAccountBusyError, withLedgerAccountLock } from '../src/ledger-lock';
import { PostgresQboTokenStore } from '../src/credentials';
import { closeAllPools, PostgresStore } from '../src/store';

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

/**
 * Connecting and disconnecting a QuickBooks company, against a real database
 * (ADR 0039, migration 0030).
 *
 * Suite 26 asks the schema its questions in SQL. This asks the ones only the
 * whole path can answer: that a claim, its credential and its audit row land
 * together or not at all; that a move, a reconnect and A → B → A each end with
 * exactly one enabled connection acting as the right person; that another
 * workspace's hold is refused by name and costs nothing; that a failed seal
 * leaves a working connection working; that two connects at once are
 * serialized rather than raced; and that nothing a caller can read afterwards —
 * an audit payload, an error — carries a token.
 */
describeDb('connecting a QuickBooks company on Postgres', () => {
  const admin = new Pool({ connectionString });
  const config = { connectionString: connectionString as string };
  const cipher = new LocalTokenCipher({ keyId: 'local-connect-key' });

  const orgA = randomUUID();
  const orgB = randomUUID();
  const ownerA = randomUUID();
  const ownerA2 = randomUUID();
  const analystA = randomUUID();
  const ownerB = randomUUID();
  const suffix = orgA.slice(0, 8);

  /** A company id: digits, fresh per run, since one company is held once per database. */
  let counter = 0;
  const base = String(Date.now()).slice(-12);
  const realm = (): string => `${base}${String((counter += 1)).padStart(3, '0')}`;

  function tokens(label: string): QboTokens {
    return {
      accessToken: `access-${label}-DO-NOT-LOG`,
      refreshToken: `refresh-${label}-DO-NOT-LOG`,
      accessExpiresAt: '2026-09-23T18:00:00.000Z',
      refreshExpiresAt: '2026-12-31T00:00:00.000Z',
    };
  }

  const as = (orgId: string, userId: string) => ({ orgId, userId });

  async function rowsFor(realmId: string) {
    const { rows } = await admin.query<{
      id: string;
      org_id: string;
      enabled: boolean;
      created_by: string;
    }>(
      `select id, org_id, enabled, created_by from accounting_connections
        where provider = 'qbo' and provider_account_id = $1 order by created_at, id`,
      [realmId],
    );
    return rows;
  }

  async function credentialCount(connectionId: string): Promise<number> {
    const { rows } = await admin.query<{ n: number }>(
      `select count(*)::int as n from accounting_credentials where connection_id = $1`,
      [connectionId],
    );
    return rows[0]?.n ?? 0;
  }

  async function auditFor(connectionId: string) {
    const { rows } = await admin.query<{
      action: string;
      actor_id: string;
      payload: Record<string, unknown>;
    }>(
      `select action, actor_id, payload from audit_log
        where subject_table = 'accounting_connections' and subject_id = $1 order by id`,
      [connectionId],
    );
    return rows;
  }

  async function loaded(orgId: string, userId: string, connectionId: string, realmId: string) {
    return new PostgresQboTokenStore(config, as(orgId, userId), { connectionId, realmId }, cipher).load(
      realmId,
    );
  }

  beforeAll(async () => {
    await admin.query(
      `insert into organizations (id, slug, name) values ($1,$2,'Connect A'), ($3,$4,'Connect B')`,
      [orgA, `conn-a-${suffix}`, orgB, `conn-b-${suffix}`],
    );
    await admin.query(`insert into org_settings (org_id) values ($1), ($2)`, [orgA, orgB]);
    await admin.query(
      `insert into users (id, email) values ($1,$2), ($3,$4), ($5,$6), ($7,$8)`,
      [
        ownerA, `conn-owner-a-${suffix}@example.test`,
        ownerA2, `conn-owner-a2-${suffix}@example.test`,
        analystA, `conn-analyst-a-${suffix}@example.test`,
        ownerB, `conn-owner-b-${suffix}@example.test`,
      ],
    );
    await admin.query(
      `insert into memberships (org_id, user_id, role)
       values ($1,$2,'owner'), ($1,$3,'owner'), ($1,$4,'analyst'), ($5,$6,'owner')`,
      [orgA, ownerA, ownerA2, analystA, orgB, ownerB],
    );
  });

  afterAll(async () => {
    // Nothing is deleted: the credential and audit tables are append-only and
    // their triggers refuse the owner too. The database is a throwaway.
    await closeAllPools();
    await admin.end();
  });

  it('connects: one enabled row, one sealed credential, one audit row naming the owner', async () => {
    const realmId = realm();
    const result = await connectQboCompany(config, as(orgA, ownerA), {
      realmId,
      tokens: tokens('first'),
      cipher,
      via: 'web_consent',
      environment: 'sandbox',
    });

    expect(result.outcome).toBe('connected');
    expect(result.replacedConnectionIds).toEqual([]);
    const rows = await rowsFor(realmId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ org_id: orgA, enabled: true, created_by: ownerA });
    expect(await credentialCount(result.connection.connectionId)).toBe(1);
    expect(await loaded(orgA, ownerA, result.connection.connectionId, realmId)).toEqual(
      tokens('first'),
    );

    const audit = await auditFor(result.connection.connectionId);
    expect(audit).toEqual([
      {
        action: 'accounting_connection.connected',
        actor_id: ownerA,
        payload: {
          provider: 'qbo',
          provider_account_id: realmId,
          via: 'web_consent',
          environment: 'sandbox',
          credential_id: result.credentialId,
        },
      },
    ]);
    expect(JSON.stringify(audit)).not.toContain('DO-NOT-LOG');
  });

  it('reconnects the same member’s row with new tokens, as a rotation on the same chain', async () => {
    const realmId = realm();
    const first = await connectQboCompany(config, as(orgA, ownerA), {
      realmId,
      tokens: tokens('one'),
      cipher,
      via: 'web_consent',
    });
    const again = await connectQboCompany(config, as(orgA, ownerA), {
      realmId,
      tokens: tokens('two'),
      cipher,
      via: 'web_consent',
    });

    expect(again.outcome).toBe('reconnected');
    expect(again.connection.connectionId).toBe(first.connection.connectionId);
    expect(await rowsFor(realmId)).toHaveLength(1);
    expect(await credentialCount(first.connection.connectionId)).toBe(2);
    expect(await loaded(orgA, ownerA, first.connection.connectionId, realmId)).toEqual(
      tokens('two'),
    );
  });

  it('re-enables a connection its member turned off, rather than making another', async () => {
    const realmId = realm();
    const first = await connectQboCompany(config, as(orgA, ownerA), {
      realmId,
      tokens: tokens('one'),
      cipher,
      via: 'web_consent',
    });
    await disconnectLedger(config, as(orgA, ownerA), {
      connectionId: first.connection.connectionId,
      via: 'web_consent',
    });
    expect((await rowsFor(realmId))[0]?.enabled).toBe(false);

    const again = await connectQboCompany(config, as(orgA, ownerA), {
      realmId,
      tokens: tokens('two'),
      cipher,
      via: 'web_consent',
    });

    expect(again.outcome).toBe('reconnected');
    expect(again.connection.connectionId).toBe(first.connection.connectionId);
    expect(await rowsFor(realmId)).toEqual([
      expect.objectContaining({ id: first.connection.connectionId, enabled: true }),
    ]);
  });

  it('moves a connection to another owner as a new row, and the fan-out lists it once', async () => {
    const realmId = realm();
    const first = await connectQboCompany(config, as(orgA, ownerA), {
      realmId,
      tokens: tokens('a'),
      cipher,
      via: 'web_consent',
    });

    const moved = await connectQboCompany(config, as(orgA, ownerA2), {
      realmId,
      tokens: tokens('a2'),
      cipher,
      via: 'operator_command',
    });

    expect(moved.outcome).toBe('moved');
    expect(moved.replacedConnectionIds).toEqual([first.connection.connectionId]);
    expect(moved.connection.connectionId).not.toBe(first.connection.connectionId);
    expect(moved.connection.createdBy).toBe(ownerA2);
    const rows = await rowsFor(realmId);
    expect(rows.map((row) => [row.id, row.enabled, row.created_by])).toEqual([
      [first.connection.connectionId, false, ownerA],
      [moved.connection.connectionId, true, ownerA2],
    ]);
    // The new tokens are on the new row; the old row keeps its own.
    expect(await credentialCount(moved.connection.connectionId)).toBe(1);
    expect(await loaded(orgA, ownerA2, moved.connection.connectionId, realmId)).toEqual(
      tokens('a2'),
    );

    const listed = (await listConnectionsToSync(config)).filter((row) =>
      [first.connection.connectionId, moved.connection.connectionId].includes(row.connectionId),
    );
    expect(listed.map((row) => [row.connectionId, row.createdBy])).toEqual([
      [moved.connection.connectionId, ownerA2],
    ]);

    const audit = await auditFor(moved.connection.connectionId);
    expect(audit[0]?.action).toBe('accounting_connection.moved');
    expect(audit[0]?.payload['replaced_connection_ids']).toEqual([first.connection.connectionId]);
  });

  it('moves it back: A → B → A re-enables A’s own row and turns B’s off', async () => {
    // The sequence the first design got wrong: re-enabling A's row while B's
    // was still enabled would have hit the one-enabled index and been
    // misreported as another workspace's hold.
    const realmId = realm();
    const a = await connectQboCompany(config, as(orgA, ownerA), {
      realmId, tokens: tokens('a'), cipher, via: 'web_consent',
    });
    const b = await connectQboCompany(config, as(orgA, ownerA2), {
      realmId, tokens: tokens('b'), cipher, via: 'web_consent',
    });
    const back = await connectQboCompany(config, as(orgA, ownerA), {
      realmId, tokens: tokens('a-again'), cipher, via: 'web_consent',
    });

    expect(back.outcome).toBe('moved');
    expect(back.connection.connectionId).toBe(a.connection.connectionId);
    expect(back.replacedConnectionIds).toEqual([b.connection.connectionId]);
    const rows = await rowsFor(realmId);
    expect(rows.filter((row) => row.enabled).map((row) => row.id)).toEqual([
      a.connection.connectionId,
    ]);
    expect(await loaded(orgA, ownerA, a.connection.connectionId, realmId)).toEqual(
      tokens('a-again'),
    );
  });

  it('serializes two owners connecting one company at the same moment', async () => {
    // No row exists yet, so a row lock has nothing to hold: the company's
    // advisory lock is what makes these one after the other rather than two
    // inserts racing to the unique index.
    const realmId = realm();
    const [one, two] = await Promise.all([
      connectQboCompany(config, as(orgA, ownerA), {
        realmId, tokens: tokens('x'), cipher, via: 'web_consent',
      }),
      connectQboCompany(config, as(orgA, ownerA2), {
        realmId, tokens: tokens('y'), cipher, via: 'web_consent',
      }),
    ]);

    expect([one.outcome, two.outcome].sort()).toEqual(['connected', 'moved']);
    const rows = await rowsFor(realmId);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.enabled)).toHaveLength(1);
  });

  it('serializes the same owner pressing Connect twice', async () => {
    const realmId = realm();
    const [one, two] = await Promise.all([
      connectQboCompany(config, as(orgA, ownerA), {
        realmId, tokens: tokens('p'), cipher, via: 'web_consent',
      }),
      connectQboCompany(config, as(orgA, ownerA), {
        realmId, tokens: tokens('q'), cipher, via: 'web_consent',
      }),
    ]);

    expect([one.outcome, two.outcome].sort()).toEqual(['connected', 'reconnected']);
    expect(await rowsFor(realmId)).toHaveLength(1);
    expect(await credentialCount(one.connection.connectionId)).toBe(2);
  });

  it('refuses a company another workspace holds, by name, and writes nothing at all', async () => {
    const realmId = realm();
    await connectQboCompany(config, as(orgA, ownerA), {
      realmId, tokens: tokens('held'), cipher, via: 'web_consent',
    });
    const { rows: before } = await admin.query<{ n: number }>(
      `select count(*)::int as n from audit_log where org_id = $1`,
      [orgB],
    );

    const error = await connectQboCompany(config, as(orgB, ownerB), {
      realmId, tokens: tokens('taken-DO-NOT-LOG'), cipher, via: 'web_consent',
    })
      .then(() => undefined)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AccountConnectedElsewhereError);
    expect((error as Error).message).not.toContain('DO-NOT-LOG');
    expect((await rowsFor(realmId)).filter((row) => row.org_id === orgB)).toEqual([]);
    const { rows: after } = await admin.query<{ n: number }>(
      `select count(*)::int as n from audit_log where org_id = $1`,
      [orgB],
    );
    expect(after[0]?.n).toBe(before[0]?.n);
  });

  it('lets another workspace connect once the holder disconnects', async () => {
    const realmId = realm();
    const held = await connectQboCompany(config, as(orgA, ownerA), {
      realmId, tokens: tokens('held'), cipher, via: 'web_consent',
    });
    await disconnectLedger(config, as(orgA, ownerA), {
      connectionId: held.connection.connectionId,
      via: 'web_consent',
    });

    const taken = await connectQboCompany(config, as(orgB, ownerB), {
      realmId, tokens: tokens('b'), cipher, via: 'web_consent',
    });
    expect(taken.outcome).toBe('connected');
    expect(taken.connection.orgId).toBe(orgB);
  });

  it('refuses a member who is not an owner, by name, before anything is written', async () => {
    const realmId = realm();
    await expect(
      connectQboCompany(config, as(orgA, analystA), {
        realmId, tokens: tokens('analyst'), cipher, via: 'web_consent',
      }),
    ).rejects.toBeInstanceOf(OwnerRequiredError);
    expect(await rowsFor(realmId)).toEqual([]);
  });

  it('leaves a working connection working when the seal fails on a move', async () => {
    // The first design claimed, committed, and then sealed: a KMS failure here
    // left the old connection off and a new one on with no tokens. Sealing
    // first means the failure happens before the database is touched.
    const realmId = realm();
    const working = await connectQboCompany(config, as(orgA, ownerA), {
      realmId, tokens: tokens('working'), cipher, via: 'web_consent',
    });
    const broken: TokenCipher = {
      name: 'broken',
      async encrypt() {
        throw new Error('KMS said no');
      },
      async decrypt() {
        throw new Error('KMS said no');
      },
    } as unknown as TokenCipher;

    await expect(
      connectQboCompany(config, as(orgA, ownerA2), {
        realmId, tokens: tokens('never'), cipher: broken, via: 'web_consent',
      }),
    ).rejects.toThrow(/KMS said no/);

    expect(await rowsFor(realmId)).toEqual([
      expect.objectContaining({ id: working.connection.connectionId, enabled: true, created_by: ownerA }),
    ]);
    expect(await credentialCount(working.connection.connectionId)).toBe(1);
    expect(await loaded(orgA, ownerA, working.connection.connectionId, realmId)).toEqual(
      tokens('working'),
    );
  });

  describe('disconnecting', () => {
    it('turns it off first, then revokes the latest refresh token, and records both', async () => {
      const realmId = realm();
      const made = await connectQboCompany(config, as(orgA, ownerA), {
        realmId, tokens: tokens('to-revoke'), cipher, via: 'web_consent',
      });
      const revoked: string[] = [];
      let enabledWhenRevoked: boolean | undefined;

      const result = await disconnectLedger(config, as(orgA, ownerA), {
        connectionId: made.connection.connectionId,
        via: 'web_consent',
        revoke: {
          cipher,
          revokeToken: async (token) => {
            // By the time Intuit is asked, the database already says off.
            enabledWhenRevoked = (await rowsFor(realmId))[0]?.enabled;
            revoked.push(token);
          },
        },
      });

      expect(result).toMatchObject({ disabled: true, revoke: 'confirmed' });
      expect(enabledWhenRevoked).toBe(false);
      expect(revoked).toEqual([tokens('to-revoke').refreshToken]);
      const audit = await auditFor(made.connection.connectionId);
      expect(audit.map((row) => [row.action, row.payload['result'] ?? null])).toEqual([
        ['accounting_connection.connected', null],
        ['accounting_connection.disconnected', null],
        ['accounting_connection.revoke', 'confirmed'],
      ]);
      expect(JSON.stringify(audit)).not.toContain('DO-NOT-LOG');
      expect(
        (await listConnectionsToSync(config)).some(
          (row) => row.connectionId === made.connection.connectionId,
        ),
      ).toBe(false);
    });

    it('keeps it off and says so when Intuit refuses the revoke', async () => {
      const realmId = realm();
      const made = await connectQboCompany(config, as(orgA, ownerA), {
        realmId, tokens: tokens('refused'), cipher, via: 'web_consent',
      });
      class RevokeRefused extends Error {
        override name = 'RevokeRefused';
      }

      const result = await disconnectLedger(config, as(orgA, ownerA), {
        connectionId: made.connection.connectionId,
        via: 'web_consent',
        revoke: {
          cipher,
          revokeToken: async () => {
            throw new RevokeRefused('refresh-refused-DO-NOT-LOG was rejected');
          },
        },
      });

      expect(result).toMatchObject({ disabled: true, revoke: 'failed', revokeErrorClass: 'RevokeRefused' });
      expect((await rowsFor(realmId))[0]?.enabled).toBe(false);
      const audit = await auditFor(made.connection.connectionId);
      expect(audit.at(-1)?.payload).toMatchObject({ result: 'failed', error_class: 'RevokeRefused' });
      expect(JSON.stringify(audit)).not.toContain('DO-NOT-LOG');
    });

    it('still says it is off when the revoke’s audit row cannot be written', async () => {
      // The owner is demoted while Intuit is being asked: the disable was
      // committed and audited as an owner, and the revoke's row is refused.
      const realmId = realm();
      const made = await connectQboCompany(config, as(orgA, ownerA2), {
        realmId, tokens: tokens('demoted'), cipher, via: 'web_consent',
      });
      try {
        const result = await disconnectLedger(config, as(orgA, ownerA2), {
          connectionId: made.connection.connectionId,
          via: 'web_consent',
          revoke: {
            cipher,
            revokeToken: async () => {
              await admin.query(
                `update memberships set role = 'read_only' where org_id = $1 and user_id = $2`,
                [orgA, ownerA2],
              );
            },
          },
        });

        expect(result).toMatchObject({ disabled: true, revoke: 'confirmed' });
        expect(result?.revokeAuditErrorClass).toMatch(/42501/);
        expect((await rowsFor(realmId))[0]?.enabled).toBe(false);
        expect(
          (await auditFor(made.connection.connectionId)).map((row) => row.action),
        ).toEqual(['accounting_connection.connected', 'accounting_connection.disconnected']);
      } finally {
        await admin.query(
          `update memberships set role = 'owner' where org_id = $1 and user_id = $2`,
          [orgA, ownerA2],
        );
      }
    });

    it('records the revoke as not attempted where this deployment cannot reach Intuit', async () => {
      const realmId = realm();
      const made = await connectQboCompany(config, as(orgA, ownerA), {
        realmId, tokens: tokens('no-app'), cipher, via: 'web_consent',
      });
      const result = await disconnectLedger(config, as(orgA, ownerA), {
        connectionId: made.connection.connectionId,
        via: 'operator_command',
      });
      expect(result).toMatchObject({ disabled: true, revoke: 'not_attempted' });
      expect((await auditFor(made.connection.connectionId)).at(-1)?.payload).toMatchObject({
        result: 'not_attempted',
        via: 'operator_command',
      });
    });

    it('does nothing the second time, and nothing for a member who is not an owner', async () => {
      const realmId = realm();
      const made = await connectQboCompany(config, as(orgA, ownerA), {
        realmId, tokens: tokens('twice'), cipher, via: 'web_consent',
      });

      await expect(
        disconnectLedger(config, as(orgA, analystA), {
          connectionId: made.connection.connectionId,
          via: 'web_consent',
        }),
      ).rejects.toBeInstanceOf(OwnerRequiredError);
      expect((await rowsFor(realmId))[0]?.enabled).toBe(true);

      await disconnectLedger(config, as(orgA, ownerA), {
        connectionId: made.connection.connectionId,
        via: 'web_consent',
      });
      const auditBefore = (await auditFor(made.connection.connectionId)).length;
      const again = await disconnectLedger(config, as(orgA, ownerA), {
        connectionId: made.connection.connectionId,
        via: 'web_consent',
      });
      expect(again).toMatchObject({ disabled: false, revoke: 'not_attempted' });
      expect(await auditFor(made.connection.connectionId)).toHaveLength(auditBefore);
    });

    it('does not find another tenant’s connection at all', async () => {
      const realmId = realm();
      const made = await connectQboCompany(config, as(orgA, ownerA), {
        realmId, tokens: tokens('theirs'), cipher, via: 'web_consent',
      });
      expect(
        await disconnectLedger(config, as(orgB, ownerB), {
          connectionId: made.connection.connectionId,
          via: 'web_consent',
        }),
      ).toBeUndefined();
      expect((await rowsFor(realmId))[0]?.enabled).toBe(true);
    });
  });

  describe('releasing a connection Intuit refused (ADR 0046)', () => {
    /** Connects a fresh company as ownerA and names the stored sign-in a refresh would present. */
    async function connectedWithCredential() {
      const realmId = realm();
      const made = await connectQboCompany(config, as(orgA, ownerA), {
        realmId, tokens: tokens('refused'), cipher, via: 'web_consent',
      });
      const store = new PostgresQboTokenStore(
        config,
        as(orgA, ownerA),
        { connectionId: made.connection.connectionId, realmId },
        cipher,
      );
      expect(store.loadedCredential()).toBeUndefined();
      await store.load(realmId);
      const credentialId = store.loadedCredential();
      expect(credentialId).toBeDefined();
      return { realmId, connectionId: made.connection.connectionId, credentialId: credentialId as string };
    }

    it('turns it off and says so on the audit trail, as the member the sync acts as', async () => {
      const { realmId, connectionId, credentialId } = await connectedWithCredential();
      const before = await credentialCount(connectionId);
      const runs = new PostgresLedgerSyncStore(config, as(orgA, ownerA), new PostgresStore(config, as(orgA, ownerA)));

      expect(
        await runs.releaseDeadConnection({ connectionId, credentialId, reason: 'grant_refused' }),
      ).toBe('released');

      expect((await rowsFor(realmId))[0]?.enabled).toBe(false);
      // Nothing is deleted: the dead sign-in stays on its chain.
      expect(await credentialCount(connectionId)).toBe(before);
      const trail = await auditFor(connectionId);
      expect(trail.slice(-2)).toEqual([
        {
          action: 'accounting_connection.disconnected',
          actor_id: ownerA,
          payload: {
            provider: 'qbo',
            provider_account_id: realmId,
            via: 'ledger_sync',
            reason: 'grant_refused',
            credential_id: credentialId,
          },
        },
        {
          action: 'accounting_connection.revoke',
          actor_id: ownerA,
          payload: {
            provider: 'qbo',
            provider_account_id: realmId,
            via: 'ledger_sync',
            result: 'not_attempted',
          },
        },
      ]);

      // The settings page can say why it is off.
      const overview = (await runs.ledgerConnectionOverview()).find(
        (row) => row.connectionId === connectionId,
      );
      expect(overview?.enabled).toBe(false);
      expect(overview?.releasedBySync?.reason).toBe('grant_refused');

      // And the company is no longer held from anyone.
      const taken = await connectQboCompany(config, as(orgB, ownerB), {
        realmId, tokens: tokens('after-release'), cipher, via: 'web_consent',
      });
      expect(taken.outcome).toBe('connected');
    });

    it('lets the same owner connect again, after which the page no longer speaks of the release', async () => {
      const { connectionId, credentialId, realmId } = await connectedWithCredential();
      await releaseDeadLedger(config, as(orgA, ownerA), {
        connectionId, credentialId, reason: 'refresh_expired',
      });
      const again = await connectQboCompany(config, as(orgA, ownerA), {
        realmId, tokens: tokens('consented-again'), cipher, via: 'web_consent',
      });
      expect(again.outcome).toBe('reconnected');
      expect(again.connection.connectionId).toBe(connectionId);

      const runs = new PostgresLedgerSyncStore(config, as(orgA, ownerA), new PostgresStore(config, as(orgA, ownerA)));
      const overview = (await runs.ledgerConnectionOverview()).find(
        (row) => row.connectionId === connectionId,
      );
      expect(overview?.enabled).toBe(true);
      expect(overview?.releasedBySync).toBeUndefined();
    });

    it('leaves it on when a newer sign-in was stored since — a reconnect is never undone', async () => {
      const { realmId, connectionId, credentialId } = await connectedWithCredential();
      await connectQboCompany(config, as(orgA, ownerA), {
        realmId, tokens: tokens('reconnected-meanwhile'), cipher, via: 'web_consent',
      });
      const trailBefore = (await auditFor(connectionId)).length;

      expect(
        await releaseDeadLedger(config, as(orgA, ownerA), {
          connectionId, credentialId, reason: 'grant_refused',
        }),
      ).toBe('newer_sign_in');
      expect((await rowsFor(realmId))[0]?.enabled).toBe(true);
      expect(await auditFor(connectionId)).toHaveLength(trailBefore);
    });

    it('writes nothing for a connection that is already off', async () => {
      const { connectionId, credentialId } = await connectedWithCredential();
      await disconnectLedger(config, as(orgA, ownerA), { connectionId, via: 'web_consent' });
      const trailBefore = (await auditFor(connectionId)).length;

      expect(
        await releaseDeadLedger(config, as(orgA, ownerA), {
          connectionId, credentialId, reason: 'grant_refused',
        }),
      ).toBe('already_off');
      expect(await auditFor(connectionId)).toHaveLength(trailBefore);
    });

    it('refuses a member who is not an owner, and another tenant finds nothing', async () => {
      const { realmId, connectionId, credentialId } = await connectedWithCredential();

      await expect(
        releaseDeadLedger(config, as(orgA, analystA), {
          connectionId, credentialId, reason: 'grant_refused',
        }),
      ).rejects.toBeInstanceOf(OwnerRequiredError);
      expect(
        await releaseDeadLedger(config, as(orgB, ownerB), {
          connectionId, credentialId, reason: 'grant_refused',
        }),
      ).toBeUndefined();
      expect((await rowsFor(realmId))[0]?.enabled).toBe(true);
    });
  });

  it('holds one company’s lock across two processes’ worth of stores', async () => {
    // Two token stores for the same company, as two sync processes would have.
    // The second holder must not start until the first has finished.
    const realmId = realm();
    const made = await connectQboCompany(config, as(orgA, ownerA), {
      realmId, tokens: tokens('lock'), cipher, via: 'web_consent',
    });
    const scope = { connectionId: made.connection.connectionId, realmId };
    const first = new PostgresQboTokenStore(config, as(orgA, ownerA), scope, cipher);
    const second = new PostgresQboTokenStore(config, as(orgA, ownerA), scope, cipher);
    const spans: Array<[string, number]> = [];

    const hold = (store: PostgresQboTokenStore, name: string) =>
      store.withRefreshLock(realmId, async () => {
        spans.push([`${name}:in`, Date.now()]);
        await new Promise((resolve) => setTimeout(resolve, 150));
        spans.push([`${name}:out`, Date.now()]);
      });

    await Promise.all([hold(first, 'first'), hold(second, 'second')]);

    const order = spans.map(([name]) => name);
    // Whichever got it first, it came out before the other went in.
    expect([
      ['first:in', 'first:out', 'second:in', 'second:out'],
      ['second:in', 'second:out', 'first:in', 'first:out'],
    ]).toContainEqual(order);
  });

  it('gives up on a company whose lock is held too long, runs nothing, and leaves the pool usable', async () => {
    const realmId = realm();
    const key = { provider: 'qbo', providerAccountId: realmId };
    const tenant = as(orgA, ownerA);
    // A lock pool of one connection, so the call after the failure borrows the
    // very connection the failure happened on.
    const single = { ...config, max: 1 };

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const holder = withLedgerAccountLock(config, tenant, key, async () => {
      entered();
      await held;
    });
    await inside;

    let ran = false;
    await expect(
      withLedgerAccountLock(single, tenant, key, async () => {
        ran = true;
      }, { waitMs: 200 }),
    ).rejects.toBeInstanceOf(LedgerAccountBusyError);
    expect(ran).toBe(false);

    release();
    await holder;
    await expect(withLedgerAccountLock(single, tenant, key, async () => 'next')).resolves.toBe('next');
  });

  it('shows the settings page who connected it, when its tokens expire, and no credential', async () => {
    const realmId = realm();
    const made = await connectQboCompany(config, as(orgA, ownerA), {
      realmId, tokens: tokens('overview'), cipher, via: 'web_consent',
    });
    const tenant = as(orgA, ownerA);
    const runs = new PostgresLedgerSyncStore(config, tenant, new PostgresStore(config, tenant));

    const overview = (await runs.ledgerConnectionOverview()).find(
      (row) => row.connectionId === made.connection.connectionId,
    );

    expect(overview).toMatchObject({
      providerAccountId: realmId,
      enabled: true,
      createdBy: ownerA,
      createdByEmail: `conn-owner-a-${suffix}@example.test`,
      latestCredential: {
        refreshExpiresAt: '2026-12-31T00:00:00.000Z',
        accessExpiresAt: '2026-09-23T18:00:00.000Z',
      },
    });
    expect(overview?.lastRun).toBeUndefined();
    expect(JSON.stringify(overview)).not.toContain('DO-NOT-LOG');
  });
});

describe('the claim rule', () => {
  const row = (connectionId: string, createdBy: string, enabled: boolean) => ({
    connectionId,
    orgId: 'org',
    provider: 'qbo' as const,
    providerAccountId: '1',
    enabled,
    createdBy,
  });

  it('connects when this org has nothing, reconnects this member’s own, and moves another’s', () => {
    expect(planLedgerClaim([], 'me')).toEqual({ outcome: 'connected', disable: [] });
    expect(planLedgerClaim([row('mine', 'me', false)], 'me')).toMatchObject({
      outcome: 'reconnected',
      reuse: { connectionId: 'mine' },
      disable: [],
    });
    expect(
      planLedgerClaim([row('theirs', 'them', true), row('mine', 'me', false)], 'me'),
    ).toMatchObject({
      outcome: 'moved',
      reuse: { connectionId: 'mine' },
      disable: [{ connectionId: 'theirs' }],
    });
    // Another member's row that is already off is history, not a move.
    expect(planLedgerClaim([row('old', 'them', false)], 'me')).toEqual({
      outcome: 'connected',
      disable: [],
    });
  });
});
