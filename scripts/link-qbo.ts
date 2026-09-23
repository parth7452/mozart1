/**
 * Connect a tenant's QuickBooks company from an operator's `.env`, sealed
 * (ADR 0033), by the same path the Settings → QuickBooks button takes
 * (ADR 0039).
 *
 *   pnpm link:qbo --org harborline --as owner@harborline.test
 *   pnpm link:qbo --org harborline --as owner@harborline.test --dry-run
 *
 * The button is the way in now: an owner consents at Intuit and nothing passes
 * through a laptop. This is the fallback, and it follows the button's rules
 * because it calls the button's function, `connectQboCompany` — only an owner,
 * one enabled connection per company across the deployment, seal first, then
 * the claim, the credential and the audit row in one transaction. So a run as
 * the member who already holds the connection **re-enables** it and stores the
 * new tokens, and a run as a different owner **moves** it to them — which is
 * what "run it again as somebody current" after a `refused` sync is supposed to
 * do, and until ADR 0039 did not.
 *
 * It resolves the org and the member it acts as through `app.member_for_link()`
 * as `app_rw` (ADR 0034), then does every write through the tenant's own
 * policies as `app_rw`. `DATABASE_URL` is the login the app uses, never the
 * owner.
 *
 * **It seals with the real KMS cipher and there is no flag that changes that.**
 * `@recouple/crypto/testing` holds a local cipher for tests; this file does not
 * import it, and a token sealed with it would be a token nothing in production
 * could open (ADR 0033 §4).
 *
 * It prints ids. It never prints a token, a secret, or a fragment of one —
 * including inside an error message, which is why every failure below is a
 * sentence rather than a dump of what it was given.
 */

import 'dotenv/config';
import { KmsTokenCipher } from '@recouple/crypto';
import {
  AccountConnectedElsewhereError,
  closeAllPools,
  connectQboCompany,
  planLedgerClaim,
  resolveOperator,
  PostgresLedgerSyncStore,
  PostgresStore,
} from '@recouple/store-postgres';

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const HELP = `Connect a QuickBooks company to a tenant and store its tokens.

The Settings → QuickBooks page is the usual way to do this. This command is the
fallback, and it follows the same rules.

  pnpm link:qbo --org <slug> --as <owner email> [--realm <company id>] [--dry-run]

Options:
  --org      the tenant's slug. No default: a connection belongs to one customer
  --as       the owner this acts as, by email. No default — and the member a
             scheduled sync will act as from then on, so make it somebody who
             will still be here next quarter. Only an owner may connect.
             Run as the owner who already holds the connection, it re-enables
             it with the new tokens; run as a different owner, it moves the
             connection to them
  --realm    the QuickBooks company id, if it is not QBO_REALM_ID in .env
  --dry-run  say what would happen; write nothing and call nothing

What has to be in .env (the file at the top of this repository):

  DATABASE_URL           the database this writes to
  QBO_REALM_ID           the QuickBooks company id (Intuit calls it the realm id)
  QBO_REFRESH_TOKEN      the refresh token from the OAuth playground
  QBO_TOKEN_KMS_KEY_ID   the AWS key that seals it — an alias like
                         alias/recouple-qbo-tokens, or a full key ARN
  AWS_REGION             the region that key lives in
  AWS_ACCESS_KEY_ID      the identity allowed to use that key, and
  AWS_SECRET_ACCESS_KEY  its password. Nothing else in AWS needs to work.

  QBO_ACCESS_TOKEN       optional. Without it the first ledger read refreshes
                         first, which costs one round trip and always works
  QBO_ACCESS_EXPIRES_AT  optional, an ISO timestamp — when that access token
                         stops working. Without it we assume it already has
  QBO_REFRESH_EXPIRES_AT optional, an ISO timestamp. Without it we assume
                         Intuit's usual hundred days from today

The once-per-deployment AWS setup — one key, one identity that may use only
that key, and where these variables go on Vercel — is written out for somebody
who does not work in AWS every day in docs/qbo-credentials.md.

Afterwards: delete QBO_REFRESH_TOKEN and QBO_ACCESS_TOKEN from your .env. They
are in the database now, sealed, and the copy on your laptop is the one nothing
is protecting.
`;

if (has('help') || has('h')) {
  console.log(HELP);
  process.exit(0);
}

function usage(problem: string): never {
  console.error(`${problem}\n\n${HELP}`);
  process.exit(2);
}

/** Intuit's documented refresh-token lifetime, used only as a stated default. */
const REFRESH_TOKEN_DAYS = 100;

/**
 * An access token we are told nothing about is treated as already expired.
 *
 * The conservative direction, and the only safe one: refreshing early costs a
 * round trip, and using a token that has in fact expired costs the first sync
 * and reports as `QboAuthError`, which reads like a connection nobody
 * authorised.
 */
const ALREADY_EXPIRED = new Date(0).toISOString();

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString.trim() === '') usage('set DATABASE_URL');

const slug = flag('org') ?? usage('--org is required');
const actorEmail = flag('as') ?? usage('--as <member email> is required: a change has an author');
const dryRun = has('dry-run');

const realmId = (flag('realm') ?? process.env.QBO_REALM_ID ?? '').trim();
if (realmId === '') usage('set QBO_REALM_ID in .env, or pass --realm');
if (!/^\d{1,20}$/.test(realmId)) {
  usage('a QuickBooks company id is digits — the realmId Intuit shows for the company');
}

const refreshToken = (process.env.QBO_REFRESH_TOKEN ?? '').trim();
if (refreshToken === '') usage('set QBO_REFRESH_TOKEN in .env');

const kmsKeyId = (process.env.QBO_TOKEN_KMS_KEY_ID ?? '').trim();
if (kmsKeyId === '') {
  usage(
    'set QBO_TOKEN_KMS_KEY_ID in .env. Tokens are sealed with an AWS KMS key before they are ' +
      'stored, and there is no option that skips that — see docs/qbo-credentials.md',
  );
}

const accessToken = (process.env.QBO_ACCESS_TOKEN ?? '').trim();
const accessExpiresAt =
  accessToken === '' ? ALREADY_EXPIRED : isoOrNothing('QBO_ACCESS_EXPIRES_AT') ?? ALREADY_EXPIRED;
const refreshExpiresAt =
  isoOrNothing('QBO_REFRESH_EXPIRES_AT') ??
  new Date(Date.now() + REFRESH_TOKEN_DAYS * 86_400_000).toISOString();

const region = (process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? '').trim();

async function main(): Promise<void> {
  // Resolved as the app resolves anything (ADR 0034): `app_rw`, no claims, one
  // definer function that answers this and nothing else. The member has to be a
  // member of *this* tenant and has to be allowed to write. Both are the
  // database's answer, not ours — and the tenant policies ask again on write.
  const actor = await resolveOperator(
    { connectionString: connectionString as string },
    { slug, email: actorEmail },
  );
  if (actor.role !== 'owner') {
    // The database refuses anyone else too (migration 0030); this says so by
    // name rather than as a policy violation.
    throw new Error(
      `${actorEmail} is ${actor.role} in ${slug}; only an owner connects a ledger (ADR 0039)`,
    );
  }
  const orgId = actor.orgId;
  const actorId = actor.userId;

  const tenant = { orgId, userId: actorId };
  const config = { connectionString: connectionString as string };
  const store = new PostgresStore(config, tenant);
  const connections = new PostgresLedgerSyncStore(config, tenant, store);

  try {
    if (dryRun) {
      // Nothing is written and nothing is called — in particular no KMS call,
      // so a dry run works before the AWS half is set up and says whether the
      // database half is. It sees this tenant's rows only: whether another
      // workspace holds the company is something only the real run finds out,
      // and it refuses rather than moves.
      const plan = planLedgerClaim(
        await connections.connectionsForAccount('qbo', realmId),
        actorId,
      );
      if (plan.outcome === 'connected') {
        console.log(`would connect QuickBooks company ${realmId} to org ${orgId} as member ${actorId}`);
      } else if (plan.outcome === 'reconnected') {
        console.log(
          `would store new tokens on connection ${plan.reuse?.connectionId}` +
            `${plan.reuse?.enabled === false ? ' and enable it again' : ''}`,
        );
      } else {
        console.log(
          `would move the connection from member ${plan.disable
            .map((row) => row.createdBy)
            .join(', ')} to ${actorId}: ` +
            `${plan.disable.map((row) => row.connectionId).join(', ')} turned off, ` +
            `${plan.reuse === undefined ? 'a new connection' : `connection ${plan.reuse.connectionId}`} turned on`,
        );
      }
      console.log(`would seal them with KMS key ${kmsKeyId}${region === '' ? '' : ` in ${region}`}`);
      return;
    }

    const cipher = KmsTokenCipher.forKey(kmsKeyId, region === '' ? {} : { region });
    const environment = (process.env.QBO_ENVIRONMENT ?? '').trim();

    let result;
    try {
      result = await connectQboCompany(config, tenant, {
        realmId,
        tokens: { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt },
        cipher,
        via: 'operator_command',
        ...(environment === 'sandbox' || environment === 'production' ? { environment } : {}),
      });
    } catch (error) {
      if (error instanceof AccountConnectedElsewhereError) {
        throw new Error(
          `QuickBooks company ${realmId} is connected in another workspace. That workspace has to ` +
            'disconnect it first (Settings → QuickBooks, or pnpm unlink:qbo as one of its owners). ' +
            'Nothing was written.',
        );
      }
      throw error;
    }

    const { connection, outcome, replacedConnectionIds } = result;
    console.log(
      outcome === 'connected'
        ? `connection ${connection.connectionId} created for org ${orgId}, member ${actorId}`
        : outcome === 'reconnected'
          ? `connection ${connection.connectionId} reconnected with new tokens`
          : `connection moved to member ${actorId}: ${replacedConnectionIds.join(', ')} turned off, ` +
            `${connection.connectionId} turned on`,
    );
    console.log(`tokens sealed with KMS key ${kmsKeyId} and stored against ${connection.connectionId}`);
    if (accessToken === '' || accessExpiresAt === ALREADY_EXPIRED) {
      console.log(
        'no usable access token was given, so the first ledger read will refresh before it reads',
      );
    }
    console.log(`refresh token assumed good until ${refreshExpiresAt}`);
    console.log(
      'Now delete QBO_REFRESH_TOKEN and QBO_ACCESS_TOKEN from your .env: they are stored sealed, ' +
        'and the copy on your laptop is the one nothing is protecting.',
    );
  } finally {
    await store.close();
    await closeAllPools();
  }
}

/** An ISO timestamp from the environment, or nothing — never a guess at one. */
function isoOrNothing(name: string): string | undefined {
  const raw = (process.env[name] ?? '').trim();
  if (raw === '') return undefined;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) {
    usage(`${name} is not a date I can read: ${JSON.stringify(raw)}. Use an ISO timestamp.`);
  }
  return new Date(at).toISOString();
}

main().catch((error: unknown) => {
  // The message and nothing else. An AWS or driver error can be long and can
  // name things that do not belong in a terminal's scrollback; the class name
  // plus the sentence is what a person needs.
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exit(1);
});
