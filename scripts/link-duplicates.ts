/**
 * Name the possible duplicates a remittance line recorded and never named
 * (audit F1, `docs/audits/duplicate-counting/`).
 *
 * Before the fix beside `openCaseForLine`, a remittance line that probably
 * matched a case already open — a notice read first, then the advice that
 * short-paid it — opened its case with the match written only inside its own
 * `case.discovered` event (`probable_duplicate_of`). Nothing reads that key, so
 * the pair never appeared under Possible duplicates and could never be answered
 * or merged (ADR 0032, ADR 0042). This writes the missing
 * `case.possible_duplicate` event for each such match, in the shape `openCase`
 * writes, with the pair and its basis read from the `case.discovered` event and
 * nothing else.
 *
 *   pnpm link:duplicates --org harborline --as ap@harborline.test --dry-run
 *   pnpm link:duplicates --org harborline --as ap@harborline.test
 *
 * Safe to run twice. A pair already named in either direction is not listed,
 * and the write re-checks under both cases' row locks, so a second run — or two
 * at once — writes nothing more. Events are append-only; there is nothing to
 * undo, and a person still answers every pair this names.
 *
 * This is an operator's job, not a request path. It resolves the org and the
 * member it acts as through `app.member_for_link()` as `app_rw` (ADR 0034), then
 * does every read and write through `PostgresStore` as `app_rw` with that
 * member's claims, so the tenant policies apply exactly as they do in the app.
 * `DATABASE_URL` is the login the app uses, never the owner or the service role.
 */

import { closeAllPools, PostgresStore, resolveOperator } from '@recouple/store-postgres';

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

function usage(problem: string): never {
  console.error(`${problem}

  pnpm link:duplicates --org <slug> --as <member email> [--dry-run]

Options:
  --dry-run   list the pairs that would be named, write nothing
`);
  process.exit(2);
}

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined) usage('set DATABASE_URL');

const slug = flag('org') ?? usage('--org is required');
const actorEmail = flag('as') ?? usage('--as <member email> is required: a change has an author');
const dryRun = has('dry-run');

async function main(): Promise<void> {
  const actor = await resolveOperator(
    { connectionString: connectionString as string },
    { slug, email: actorEmail },
  );
  if (actor.role === 'read_only') {
    throw new Error(`${actorEmail} is read_only in ${slug} and may not name a possible duplicate`);
  }

  const store = new PostgresStore(
    { connectionString: connectionString as string },
    { orgId: actor.orgId, userId: actor.userId },
  );

  try {
    if (dryRun) {
      // One page. A named pair drops out of this query, so a real run walks the
      // rest by asking again; a dry run cannot, and says so when it is capped.
      const pending = await store.unnamedProbablePairs();
      for (const pair of pending) {
        console.log(
          `would name ${pair.deductionId} as a possible duplicate of ${pair.of}  ` +
            `basis=${pair.basis.join(',') || '(none)'}  from event ${pair.discoveredEventId}`,
        );
      }
      console.log(`${pending.length} pair(s) would be named; nothing was written`);
      return;
    }

    let named = 0;
    let already = 0;
    const failed = new Set<string>();
    for (;;) {
      const page = (await store.unnamedProbablePairs()).filter(
        (pair) => !failed.has(`${pair.discoveredEventId}:${pair.of}`),
      );
      if (page.length === 0) break;
      for (const pair of page) {
        const line = `${pair.deductionId} → ${pair.of}  (event ${pair.discoveredEventId})`;
        try {
          const outcome = await store.namePossibleDuplicate({
            discoveredEventId: pair.discoveredEventId,
            of: pair.of,
            recordedBy: actor.userId,
          });
          if (outcome === 'named') {
            named += 1;
            console.log(`named    ${line}`);
          } else {
            already += 1;
            console.log(`SKIPPED  ${line}  already named`);
          }
        } catch (error: unknown) {
          // A refusal is a finding, not noise: counted, printed, and never
          // retried in this run, so one bad pair cannot spin the loop.
          failed.add(`${pair.discoveredEventId}:${pair.of}`);
          console.error(`FAILED   ${line}  ${error instanceof Error ? error.message : error}`);
        }
      }
    }

    console.log(`${named} named, ${already} already named, ${failed.size} refused`);
    if (failed.size > 0) process.exitCode = 1;
  } finally {
    await store.close();
    await closeAllPools();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
