/**
 * Propose payer code mappings from a playbook draft, and load them only when
 * told to (ADR 0066).
 *
 *   pnpm seed:payer-codes --from docs/competitive/glimpse/playbook-drafts/chewy.yaml
 *
 *   pnpm seed:payer-codes --org harborline --as owner@harborline.test \
 *     --debtor chewy --from docs/competitive/glimpse/playbook-drafts/chewy.yaml \
 *     --effective-from 2026-10-01 --write
 *
 * **Dry-run unless `--write` is given** (`--dry-run` is accepted and is the
 * default). A dry run prints every row it would insert and every draft entry
 * it would not, with why. With `--org`, `--as` and `--debtor` it also says
 * which codes that debtor already has a mapping for on the start date.
 *
 * What it loads is a competitor's reading of a payer, not the payer's policy
 * and not the customer's word: every row is `source: glimpse_guide`,
 * `confidence: low`. Whether to load any of it is the founder's decision.
 *
 * A draft's code table holds *shapes* as well as codes (`MCB(yyyymmdd)`). A
 * mapping matches a printed code exactly, so a shape is reported and never
 * loaded. KeHE's and Walgreens' drafts hold no pairs at all.
 *
 * An operator's job, not a request path. It connects as the app does (ADR
 * 0034): the org and member come from `app.member_for_link()`, and every read
 * and write goes through `PostgresPayerCodeMapStore` as `app_rw` with that
 * member's claims (`seed-payer-codes-run.ts`). `--as` is required because a
 * mapping names who recorded it and the database refuses anyone but an owner
 * or approver writing as themselves. It never creates a debtor.
 */

import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { isIsoDate, proposedPayerCodeMapsFromDraft, REASON_WORDS } from '@recouple/core-domain';
import { closeAllPools } from '@recouple/store-postgres';
import { seedPayerCodes } from './seed-payer-codes-run';

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  const value = at === -1 ? undefined : process.argv[at + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

function usage(problem: string): never {
  console.error(`${problem}

  pnpm seed:payer-codes --from <playbook draft .yaml>
      list what the draft proposes; reads no database

  pnpm seed:payer-codes --org <slug> --as <member email> --debtor <retailer_key or id> \\
    --from <playbook draft .yaml> [--effective-from YYYY-MM-DD] [--write]

Options:
  --dry-run          the default: report, write nothing
  --write            insert the proposed rows (needs --effective-from)
  --effective-from   the first day the mappings apply; a draft states none
`);
  process.exit(2);
}

const from = flag('from') ?? usage('--from <playbook draft .yaml> is required');
const write = has('write');
if (write && has('dry-run')) usage('--write and --dry-run were both given');
const slug = flag('org');
const actorEmail = flag('as');
const debtorArg = flag('debtor');
const effectiveFrom = flag('effective-from');
if (effectiveFrom !== undefined && !isIsoDate(effectiveFrom)) usage('--effective-from is not a YYYY-MM-DD date');
const named = [slug, actorEmail, debtorArg].filter((v) => v !== undefined).length;
if (named !== 0 && named !== 3) usage('--org, --as and --debtor go together');
if (write && named !== 3) usage('--write needs --org, --as and --debtor');
if (write && effectiveFrom === undefined) {
  usage('--write needs --effective-from: a draft states no date its codes took effect');
}

async function main(): Promise<void> {
  const table = proposedPayerCodeMapsFromDraft(parse(readFileSync(from, 'utf8')));
  console.log(
    `${from}${table.retailerKey === undefined ? '' : ` (${table.retailerKey})`}: ` +
      `${table.proposed.length} proposed, ${table.skipped.length} not proposed`,
  );
  for (const skip of table.skipped) {
    console.log(
      `  skip     ${JSON.stringify(skip.printed)}  ${skip.reason}${skip.detail === undefined ? '' : `: ${skip.detail}`}`,
    );
  }

  if (named !== 3) {
    for (const row of table.proposed) {
      console.log(
        `  propose  ${JSON.stringify(row.payerCode)} → ${row.canonicalCode}  (${REASON_WORDS[row.canonicalCode]})`,
      );
    }
    console.log('dry run: nothing was written, and no database was read');
    return;
  }

  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined) usage('set DATABASE_URL');
  const result = await seedPayerCodes({
    config: { connectionString },
    slug: slug as string,
    actorEmail: actorEmail as string,
    debtor: debtorArg as string,
    table,
    effectiveFrom,
    write,
    today: new Date().toISOString().slice(0, 10),
    log: (line) => console.log(line),
  });
  if (result.refused > 0) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeAllPools());
