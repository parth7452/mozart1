/**
 * Disconnect a tenant's QuickBooks company, as one of its owners (ADR 0039 §11).
 *
 *   pnpm unlink:qbo --org harborline --as owner@harborline.test --realm 9341457960434078
 *   pnpm unlink:qbo --org harborline --as owner@harborline.test --connection <id> --dry-run
 *
 * The Settings → QuickBooks page's Disconnect is the usual way. This is the
 * operator's, for the case the button cannot reach: one enabled connection per
 * company across the deployment means a connection that stays enabled after its
 * grant died — an agency that stopped working for the manufacturer, a workspace
 * whose owner left — would block every other workspace from that company. This
 * releases it.
 *
 * It calls the button's function, `disconnectLedger`: the company's lock, the
 * connection turned off and audited first, then the refresh token revoked at
 * Intuit where this machine can — with `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET` and
 * `QBO_TOKEN_KMS_KEY_ID` in `.env` — and the revoke's result audited. The
 * audit rows say `operator_command`, so a release by an operator is never
 * mistaken for the customer's own.
 *
 * Resolved through `app.member_for_link()` as `app_rw` (ADR 0034), written
 * through the tenant's own policies as `app_rw`. It prints ids and outcomes,
 * never a token.
 */

import 'dotenv/config';
import { KmsTokenCipher } from '@recouple/crypto';
import { revokeIntuitToken } from '@recouple/qbo';
import {
  closeAllPools,
  disconnectLedger,
  resolveOperator,
  PostgresLedgerSyncStore,
  PostgresStore,
} from '@recouple/store-postgres';

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const HELP = `Disconnect a tenant's QuickBooks company, as one of its owners.

The Settings → QuickBooks page is the usual way. This command is for releasing
a company held by a connection nobody is using any more, so another workspace
can connect it.

  pnpm unlink:qbo --org <slug> --as <owner email> (--realm <company id> | --connection <id>)
                  [--no-revoke] [--dry-run]

Options:
  --org         the tenant that holds the connection. No default
  --as          an owner of that tenant, by email. No default: a change has an author,
                and the audit rows name this member and say operator_command
  --realm       the QuickBooks company id; the tenant's enabled connection to it
  --connection  or the connection's id
  --no-revoke   turn it off here without asking Intuit to end the grant
  --dry-run     say what would happen; write nothing and call nothing

To revoke at Intuit as well, .env needs QBO_CLIENT_ID, QBO_CLIENT_SECRET and
QBO_TOKEN_KMS_KEY_ID (with the AWS identity docs/qbo-credentials.md describes).
Without them the connection is still turned off, and the revoke is recorded as
not attempted.
`;

if (has('help') || has('h')) {
  console.log(HELP);
  process.exit(0);
}

function usage(problem: string): never {
  console.error(`${problem}\n\n${HELP}`);
  process.exit(2);
}

const connectionString = (process.env.DATABASE_URL ?? '').trim();
if (connectionString === '') usage('set DATABASE_URL');

const slug = flag('org') ?? usage('--org is required');
const actorEmail = flag('as') ?? usage('--as <owner email> is required: a change has an author');
const realmFlag = flag('realm')?.trim();
const connectionFlag = flag('connection')?.trim();
if ((realmFlag === undefined) === (connectionFlag === undefined)) {
  usage('name the connection with exactly one of --realm or --connection');
}
const dryRun = has('dry-run');
const noRevoke = has('no-revoke');

async function main(): Promise<void> {
  const actor = await resolveOperator({ connectionString }, { slug, email: actorEmail });
  if (actor.role !== 'owner') {
    throw new Error(
      `${actorEmail} is ${actor.role} in ${slug}; only an owner disconnects a ledger (ADR 0039)`,
    );
  }
  const tenant = { orgId: actor.orgId, userId: actor.userId };
  const config = { connectionString };
  const store = new PostgresStore(config, tenant);
  const connections = new PostgresLedgerSyncStore(config, tenant, store);

  try {
    const target =
      connectionFlag !== undefined
        ? await connections.connection(connectionFlag)
        : await connections.connectionForAccount('qbo', realmFlag as string);
    if (target === undefined) {
      throw new Error(`org ${slug} has no such QuickBooks connection. Nothing was changed.`);
    }
    if (!target.enabled) {
      console.log(`connection ${target.connectionId} is already off. Nothing to do.`);
      return;
    }

    const clientId = (process.env.QBO_CLIENT_ID ?? '').trim();
    const clientSecret = (process.env.QBO_CLIENT_SECRET ?? '').trim();
    const kmsKeyId = (process.env.QBO_TOKEN_KMS_KEY_ID ?? '').trim();
    const region = (process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? '').trim();
    const canRevoke = !noRevoke && clientId !== '' && clientSecret !== '' && kmsKeyId !== '';

    if (dryRun) {
      console.log(
        `would turn off connection ${target.connectionId} (QuickBooks company ${target.providerAccountId}) ` +
          `in org ${actor.orgId}, as member ${actor.userId}`,
      );
      console.log(
        canRevoke
          ? 'and would then revoke its refresh token at Intuit'
          : noRevoke
            ? 'and would not ask Intuit to revoke anything (--no-revoke)'
            : 'and could not revoke at Intuit: QBO_CLIENT_ID, QBO_CLIENT_SECRET or QBO_TOKEN_KMS_KEY_ID is not set',
      );
      return;
    }

    const result = await disconnectLedger(config, tenant, {
      connectionId: target.connectionId,
      via: 'operator_command',
      ...(canRevoke
        ? {
            revoke: {
              cipher: KmsTokenCipher.forKey(kmsKeyId, region === '' ? {} : { region }),
              revokeToken: (token: string) => revokeIntuitToken({ clientId, clientSecret }, token),
            },
          }
        : {}),
    });
    if (result === undefined) {
      throw new Error(`connection ${target.connectionId} is no longer visible. Nothing was changed.`);
    }

    console.log(
      result.disabled
        ? `connection ${result.connection.connectionId} turned off`
        : `connection ${result.connection.connectionId} was already off`,
    );
    console.log(
      result.revoke === 'confirmed'
        ? 'Intuit confirmed the revoke: this deployment can no longer read those books'
        : result.revoke === 'failed'
          ? `the revoke at Intuit failed (${result.revokeErrorClass ?? 'unknown'}). The connection is off ` +
            'here regardless; the customer can also remove the app in QuickBooks → Settings → Apps'
          : 'no revoke was attempted at Intuit',
    );
  } finally {
    await store.close();
    await closeAllPools();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exit(1);
});
