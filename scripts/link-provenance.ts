/**
 * Record how a document that predates provenance recording arrived (ADR 0024).
 *
 * `ingestDocument` has written an `uploads` row on every path since
 * 2026-09-21, and `declineCase` derives `declined_candidates.discovered_from`
 * from it. The documents stored before that have `documents.upload_id` null, so
 * their cases are refused rather than attributed to a guess — and migration
 * 0019 froze `uploads`, which closed the last lever that could have papered
 * over it. `document_arrivals` is the one way back, and this is how a person
 * writes one.
 *
 *   pnpm link:provenance --org harborline --as ap@harborline.test --list
 *
 *   pnpm link:provenance --org harborline --as ap@harborline.test \
 *     --source web_upload --document 0f9c… --detail "pre-Postmark: only door open"
 *
 *   pnpm link:provenance --org harborline --as ap@harborline.test \
 *     --source web_upload --all-unrecorded --dry-run
 *
 * `--source` has no default and never will. The fact that would justify one —
 * `ingestInboundEmail` has never had a production caller, so every
 * pre-provenance production document arrived by web upload — is an assertion
 * about *this deployment*, not a derivation from anything in the database, and
 * an assertion belongs in an ADR and in somebody's typed argument rather than
 * in a default nobody reads (ADR 0024 §3).
 *
 * It never overwrites. A document that already records an arrival — observed at
 * ingest, or asserted by an earlier run — is reported and skipped; the database
 * refuses it as well, twice over, so the check here is politeness rather than
 * the rule. Each write is final: `unique (document_id)` plus the append-only
 * triggers mean the first assertion about a document is the last one, which is
 * why `--dry-run` prints exactly what would be written before anything is.
 *
 * This is an operator's job, not a request path. It resolves the org and the
 * member it acts as with the admin connection, then does every write through
 * `PostgresStore` as `app_rw`, so the tenant policies apply to the change the
 * same way they apply to the app.
 */

import { Pool } from 'pg';
import { UNREAD_DOCUMENTS_MAX_LIMIT } from '@recouple/pipeline';
import {
  ArrivalAlreadyRecordedError,
  ASSERTABLE_SOURCES,
  closeAllPools,
  isAssertableSource,
  PostgresStore,
} from '@recouple/store-postgres';

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

function usage(problem: string): never {
  console.error(`${problem}

  pnpm link:provenance --org <slug> --as <member email> --list

  pnpm link:provenance --org <slug> --as <member email> \\
    --source <${ASSERTABLE_SOURCES.join('|')}> --document <uuid> [--detail "why"]

  pnpm link:provenance --org <slug> --as <member email> \\
    --source <channel> --all-unrecorded

Options:
  --list             show the documents that record no arrival, and stop
  --source           REQUIRED to write. There is no default: which channel
                     found a deduction is an assertion somebody signs
  --document <uuid>  one document; repeat the flag for more than one
  --all-unrecorded   every document of this tenant that records no arrival
  --detail "…"       why you believe it. Stored on the row, read by whoever
                     audits a coverage number later
  --dry-run          report what would be written, write nothing
`);
  process.exit(2);
}

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined) usage('set DATABASE_URL');

const slug = flag('org') ?? usage('--org is required');
const actorEmail = flag('as') ?? usage('--as <member email> is required: a change has an author');
const listOnly = has('list');
const all = has('all-unrecorded');
const dryRun = has('dry-run');
const detail = flag('detail');

/** Every `--document` on the line, not only the first: one run, one assertion each. */
const documentIds = process.argv
  .map((arg, index) => (arg === '--document' ? process.argv[index + 1] : undefined))
  .filter((value): value is string => value !== undefined);

const source = flag('source');
if (!listOnly) {
  if (source === undefined) {
    usage('--source is required: which channel found a deduction is not something this guesses');
  }
  if (!isAssertableSource(source)) {
    usage(
      `--source ${JSON.stringify(source)} is not a channel an arrival can be asserted from. ` +
        `One of: ${ASSERTABLE_SOURCES.join(', ')}`,
    );
  }
  if (documentIds.length === 0 && !all) {
    usage('name the documents with --document <uuid>, or pass --all-unrecorded');
  }
  if (documentIds.length > 0 && all) {
    usage('--document and --all-unrecorded are two different runs; pick one');
  }
}

const admin = new Pool({ connectionString });

async function main(): Promise<void> {
  const org = await admin.query<{ id: string }>(`select id from organizations where slug = $1`, [
    slug,
  ]);
  const orgId = org.rows[0]?.id;
  if (orgId === undefined) throw new Error(`no organization with slug ${JSON.stringify(slug)}`);

  // The member the assertion is attributed to has to be a member of *this*
  // tenant and has to be allowed to write. Both are the database's answer, not
  // ours — and `recorded_by` is not null precisely so this name survives.
  const actor = await admin.query<{ id: string; role: string }>(
    `select u.id, m.role
       from users u join memberships m on m.user_id = u.id
      where lower(u.email) = lower($1) and m.org_id = $2`,
    [actorEmail, orgId],
  );
  const actorId = actor.rows[0]?.id;
  if (actorId === undefined) throw new Error(`${actorEmail} is not a member of ${slug}`);
  if (actor.rows[0]?.role === 'read_only') {
    throw new Error(`${actorEmail} is read_only in ${slug} and may not record an arrival`);
  }

  const store = new PostgresStore(
    { connectionString: connectionString as string },
    { orgId, userId: actorId },
  );

  try {
    // Capped, like every other list here. A page at a time is what the store
    // will answer with, and a run that hit the cap says so rather than letting
    // an operator read "47 document(s)" as "all of them". Walking the rest is a
    // second run: a document that has been recorded drops out of this query.
    const unrecorded = await store.documentsWithoutArrival();
    const capped = unrecorded.length === UNREAD_DOCUMENTS_MAX_LIMIT;
    const andMore = capped
      ? ` (the most this lists in one run; re-run after recording these to see the rest)`
      : '';

    if (listOnly) {
      for (const row of unrecorded) {
        console.log(
          `${row.documentId}  ${row.createdAt}  ${row.filename || '(no filename)'}  ` +
            `cases: ${row.deductionIds.join(', ') || '(none)'}`,
        );
      }
      console.log(`${unrecorded.length} document(s) record no arrival${andMore}`);
      return;
    }

    const targets = all ? unrecorded.map((row) => row.documentId) : documentIds;
    if (targets.length === 0) {
      console.log('nothing to record: every document of this tenant already records an arrival');
      return;
    }

    let recorded = 0;
    let skipped = 0;
    let failed = 0;
    for (const documentId of targets) {
      // Printed before the write, and printed for a dry run too, because the
      // row is final once it exists. An operator should see the exact channel
      // about to be asserted against the exact document, in one line.
      const line = `${documentId}  source=${source as string}`;
      if (dryRun) {
        console.log(`would record ${line}`);
        continue;
      }
      try {
        const arrival = await store.recordDocumentArrival({
          documentId,
          source: source as (typeof ASSERTABLE_SOURCES)[number],
          recordedBy: actorId,
          ...(detail !== undefined ? { detail } : {}),
        });
        recorded += 1;
        console.log(
          `recorded ${line}  upload=${arrival.uploadId}  ` +
            `cases: ${arrival.deductionIds.join(', ') || '(none)'}`,
        );
      } catch (error: unknown) {
        // An arrival already on the document is not a failure of this run — it
        // is the answer that there was nothing to repair, or that somebody got
        // there first. Reported and counted separately from a real refusal,
        // because `--all-unrecorded` on a tenant that has already been walked
        // should read as a no-op rather than as an error every time.
        if (error instanceof ArrivalAlreadyRecordedError) {
          skipped += 1;
          console.warn(`SKIPPED  ${documentId}  ${error.message}`);
          continue;
        }
        failed += 1;
        console.error(`FAILED   ${documentId}  ${error instanceof Error ? error.message : error}`);
      }
    }

    if (dryRun) {
      console.log(`${targets.length} document(s) would be recorded; nothing was written`);
      return;
    }
    console.log(`${recorded} recorded, ${skipped} already known, ${failed} refused${
      all ? andMore : ''
    }`);
    // A refusal is a real finding — a document another tenant owns, an id that
    // does not exist, a member the policies turned down. The exit code says so
    // rather than leaving it in the scrollback.
    if (failed > 0) process.exitCode = 1;
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
