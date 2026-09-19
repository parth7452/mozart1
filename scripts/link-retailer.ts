/**
 * Tell a tenant that a debtor answers to another spelling of its name, and
 * resolve the cases that were waiting on it (ADR 0019).
 *
 * `openCase` matches a printed retailer name against the tenant's debtors and
 * their aliases, and never invents one — so "WALMART STORES, INC." stays
 * unmatched until a person says it is Walmart. This is how a person says it.
 *
 *   pnpm link:retailer --org harborline --as ap@harborline.test \
 *     --retailer walmart_apdp --alias "WALMART STORES, INC."
 *
 *   pnpm link:retailer --org harborline --as ap@harborline.test --backfill-only
 *
 * Adding the alias fixes every case from then on. The backfill is what reaches
 * back through the ones already opened, and it is a separate, deliberate step
 * rather than a side effect of adding an alias — a silent rewrite of old cases
 * is not something anyone asked for. `--dry-run` reports without writing.
 *
 * This is an operator's job, not a request path. It resolves the org and the
 * member it acts as with the admin connection, then does every write through
 * `PostgresStore` as `app_rw`, so the tenant policies apply to the change the
 * same way they apply to the app.
 */

import { Pool } from 'pg';
import { closeAllPools, PostgresStore } from '@recouple/store-postgres';

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

function usage(problem: string): never {
  console.error(`${problem}

  pnpm link:retailer --org <slug> --as <member email> \\
    --retailer <retailer_key> --alias "<name as printed>"

  pnpm link:retailer --org <slug> --as <member email> --backfill-only

Options:
  --dry-run   report what would change, write nothing
`);
  process.exit(2);
}

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined) usage('set DATABASE_URL');

const slug = flag('org') ?? usage('--org is required');
const actorEmail = flag('as') ?? usage('--as <member email> is required: a change has an author');
const backfillOnly = has('backfill-only');
const dryRun = has('dry-run');
const retailerKey = backfillOnly ? undefined : flag('retailer');
const alias = backfillOnly ? undefined : flag('alias');
if (!backfillOnly && (retailerKey === undefined || alias === undefined)) {
  usage('--retailer and --alias are both required unless --backfill-only');
}

const admin = new Pool({ connectionString });

async function main(): Promise<void> {
  const org = await admin.query<{ id: string }>(
    `select id from organizations where slug = $1`,
    [slug],
  );
  const orgId = org.rows[0]?.id;
  if (orgId === undefined) throw new Error(`no organization with slug ${JSON.stringify(slug)}`);

  // The member the change is attributed to has to be a member of *this* tenant,
  // and has to be allowed to write. Both are the database's answer, not ours.
  const actor = await admin.query<{ id: string; role: string }>(
    `select u.id, m.role
       from users u join memberships m on m.user_id = u.id
      where lower(u.email) = lower($1) and m.org_id = $2`,
    [actorEmail, orgId],
  );
  const actorId = actor.rows[0]?.id;
  if (actorId === undefined) {
    throw new Error(`${actorEmail} is not a member of ${slug}`);
  }
  if (actor.rows[0]?.role === 'read_only') {
    throw new Error(`${actorEmail} is read_only in ${slug} and may not add an alias`);
  }

  const store = new PostgresStore({ connectionString: connectionString as string }, {
    orgId,
    userId: actorId,
  });

  try {
    if (!backfillOnly) {
      const debtor = await admin.query<{ id: string; display_name: string }>(
        `select id, display_name from debtors where org_id = $1 and retailer_key = $2`,
        [orgId, retailerKey],
      );
      const debtorId = debtor.rows[0]?.id;
      if (debtorId === undefined) {
        const known = await admin.query<{ retailer_key: string }>(
          `select retailer_key from debtors where org_id = $1 order by retailer_key`,
          [orgId],
        );
        throw new Error(
          `no debtor with retailer_key ${JSON.stringify(retailerKey)} in ${slug}. ` +
            `This script never creates one — that is master data a person owns. ` +
            `Known keys: ${known.rows.map((r) => r.retailer_key).join(', ') || '(none)'}`,
        );
      }
      if (dryRun) {
        console.log(
          `would add alias ${JSON.stringify(alias)} → ${debtor.rows[0]?.display_name}`,
        );
      } else {
        await store.addDebtorAlias(debtorId, alias as string);
        console.log(`alias ${JSON.stringify(alias)} → ${debtor.rows[0]?.display_name}`);
      }
    }

    if (dryRun) {
      // Nothing was written, so a backfill now would report against the aliases
      // that already exist. Say so rather than implying a preview of the change.
      const pending = await admin.query<{ n: string }>(
        `select count(*) as n from deductions
          where org_id = $1 and debtor_id is null and retailer_name_as_printed is not null`,
        [orgId],
      );
      console.log(`${pending.rows[0]?.n ?? 0} unmatched case(s) would be re-checked`);
      return;
    }

    const backfill = await store.resolveUnmatchedCases();
    for (const row of backfill.resolved) {
      console.log(`resolved ${row.deductionId}  ${row.name}`);
    }
    for (const row of backfill.blocked) {
      console.warn(`BLOCKED  ${row.deductionId}  ${row.name}: ${row.reason}`);
    }
    console.log(
      `${backfill.resolved.length} resolved, ${backfill.blocked.length} blocked, ` +
        `${backfill.stillUnmatched} still unmatched`,
    );
    // A blocked case is two cases for one claim. It is a real finding, so the
    // exit code says so rather than leaving it in the scrollback.
    if (backfill.blocked.length > 0) process.exitCode = 1;
  } finally {
    await store.close();
    await closeAllPools();
    await admin.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
