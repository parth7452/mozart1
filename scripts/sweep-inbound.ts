/**
 * Record the inbound email Postmark accepted and could not deliver to us
 * (ADR 0047 §12).
 *
 *   pnpm sweep:inbound
 *   pnpm sweep:inbound --dry-run
 *
 * An email with more than about 3.3 MB of attachments is refused by Vercel
 * before any of our code runs. Postmark retries it, marks it Inbound Error,
 * and keeps no attachment we can fetch — so the email is lost whatever we do.
 * This makes sure it is not lost silently: each failed message from the last
 * six days whose envelope recipient is a live address becomes a `not_received`
 * row, shown under "Email that filed nothing" on that workspace's case list.
 * Run it daily until a scheduled host can hold the Postmark token.
 *
 * It reads Postmark and writes our record, nothing else: it never calls
 * Postmark's retry or bypass, and sends no mail. Each row is written as the
 * member the address acts as, through `app.record_inbound_message()` as
 * `app_rw` — the address is resolved by the claimless
 * `app.inbound_address_for()`, the webhook's own lookup — so there is no
 * service role and no operator identity to name. A second run writes nothing
 * new.
 *
 * `POSTMARK_SERVER_TOKEN` lives in this operator `.env` and never on Vercel:
 * it reads every tenant's inbound messages and can repoint the webhook. It
 * prints Postmark's MessageIDs, our ids and outcome words — never an address,
 * a token, a sender or a subject (§13).
 */

import 'dotenv/config';
import { PostmarkInboundSearch } from '@recouple/ingest';
import { sweepInboundFailures, INBOUND_STALE_AFTER_HOURS, INBOUND_SWEEP_DAYS } from '@recouple/pipeline';
import {
  closeAllPools,
  inboundAddressFor,
  PostgresInboundStore,
  PostgresStore,
} from '@recouple/store-postgres';

const has = (name: string): boolean => process.argv.includes(`--${name}`);

const HELP = `Record the inbound email Postmark could not deliver to us (ADR 0047 §12).

  pnpm sweep:inbound [--dry-run]

Reads Postmark's failed inbound messages over the last ${INBOUND_SWEEP_DAYS} days and records
each one addressed to a live workspace address as "did not reach us" on that
workspace. Reads Postmark only: nothing is retried, bypassed or sent.

Needs, in .env: POSTMARK_SERVER_TOKEN (the Postmark server's API token; never
on Vercel), INBOUND_DOMAIN and DATABASE_URL.

  --dry-run   list what would be recorded; write nothing
`;

if (has('help') || has('h')) {
  console.log(HELP);
  process.exit(0);
}

function usage(problem: string): never {
  console.error(`${problem}\n\n${HELP}`);
  process.exit(2);
}

const known = new Set(['--dry-run']);
for (const arg of process.argv.slice(2)) {
  if (!known.has(arg)) usage(`unknown argument: ${arg}`);
}

const connectionString = (process.env.DATABASE_URL ?? '').trim();
if (connectionString === '') usage('set DATABASE_URL');
const serverToken = (process.env.POSTMARK_SERVER_TOKEN ?? '').trim();
if (serverToken === '') usage('set POSTMARK_SERVER_TOKEN in this machine’s .env (never on Vercel)');
const inboundDomain = (process.env.INBOUND_DOMAIN ?? '').trim().toLowerCase();
if (inboundDomain === '') usage('set INBOUND_DOMAIN to the domain the addresses are on');
const dryRun = has('dry-run');

async function main(): Promise<void> {
  const config = { connectionString };
  const search = new PostmarkInboundSearch({ serverToken });
  try {
    const report = await sweepInboundFailures({
      postmark: {
        listFailed: (window) => search.list({ status: 'failed', ...window }),
        countOlderThan: (status, before) => search.count({ status, before }),
      },
      inboundDomain,
      lookup: (token) => inboundAddressFor(config, token),
      memberMayWrite: async (actor) => {
        const store = new PostgresStore(config, actor);
        try {
          return await store.memberMayWrite(actor);
        } finally {
          await store.close();
        }
      },
      recordNotReceived: async (address, providerMessageId, providerReceivedAt) => {
        if (dryRun) return '(dry run: not recorded)';
        return new PostgresInboundStore(config, {
          orgId: address.orgId,
          userId: address.actingMember,
        }).recordInboundMessage(
          {
            addressId: address.addressId,
            provider: 'postmark',
            providerMessageId,
            outcome: 'not_received',
            providerReceivedAt,
          },
          [],
        );
      },
      now: () => new Date(),
    });

    const failed = report.windows.reduce((sum, window) => sum + window.failed, 0);
    const oldest = report.windows.at(-1)?.day ?? '';
    const newest = report.windows[0]?.day ?? '';
    console.log(
      `inbound sweep${dryRun ? ' (dry run)' : ''}: ${failed} failed message${failed === 1 ? '' : 's'} ` +
        `on Postmark, ${oldest} to ${newest} (Eastern)`,
    );
    for (const line of report.lines) {
      if (line.kind === 'recorded') {
        console.log(
          `  ${dryRun ? 'would record' : 'recorded'}  ${line.providerMessageId}  as ${line.inboundMessageId}  ` +
            `address ${line.addressId}  org ${line.orgId}  (Postmark day ${line.day})`,
        );
      } else if (line.kind === 'member_may_not_write') {
        console.log(
          `  not recorded  ${line.providerMessageId}  address ${line.addressId}  org ${line.orgId}: ` +
            'the member it acts as may no longer write there; an owner should adopt the address',
        );
      } else {
        console.log(`  no live address  ${line.providerMessageId}  (${line.reason})`);
      }
    }
    console.log(`queued on Postmark for more than ${INBOUND_STALE_AFTER_HOURS} hours: ${report.staleQueued}`);
    console.log(
      `scheduled for retry on Postmark for more than ${INBOUND_STALE_AFTER_HOURS} hours: ${report.staleScheduled}`,
    );
    if (report.staleQueued > 0) {
      console.log('  queued messages usually mean the inbound webhook is paused (a failed payment, for one)');
    }
    if (report.staleScheduled > 0) {
      console.log('  a long retry backlog usually means the webhook is answering 401 or 503; see the app logs');
    }
  } finally {
    await closeAllPools();
  }
}

main().catch((error: unknown) => {
  // A class name and our own message: the token is in no error this raises.
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exit(1);
});
