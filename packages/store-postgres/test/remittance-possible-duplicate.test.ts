import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import {
  openCaseFromNotice,
  openCasesFromRemittance,
  type CaseOpeningDeps,
  type CaseOpeningReading,
} from '@recouple/pipeline';
import { closeAllPools, PostgresStore } from '../src/store';

const connectionString = process.env.DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const TSX = `${ROOT}node_modules/.bin/tsx`;

/**
 * Audit F1 (`docs/audits/duplicate-counting/`): a notice read first, then the
 * remittance line that short-paid it, is a pair a person can answer and merge.
 *
 * Before the fix the line's case carried the match only inside its own
 * `case.discovered` event, so `possibleDuplicates` never listed it and the
 * merge check answered `not_confirmed` for ever. Everything here goes through
 * the real `openCaseFromNotice` and `openCasesFromRemittance` over
 * `PostgresStore` as `app_rw`, so what is listed is what the pipeline wrote.
 *
 * The backfill (`pnpm link:duplicates`) is run as a subprocess on the login
 * `docs/supabase.md` prescribes — no inherited privileges, `set role app_rw`
 * only (ADR 0034) — against a case opened the way the old code opened it.
 */
describeDb('a remittance line names its possible duplicate (audit F1)', () => {
  const admin = new Pool({ connectionString });
  const orgId = randomUUID();
  const userId = randomUUID();
  const suffix = orgId.slice(0, 8);
  const slug = `f1-${suffix}`;
  const email = `f1-${suffix}@example.test`;
  const loginRole = `rc_f1_${suffix}`;
  const password = randomBytes(18).toString('hex');
  let loginUrl: string;
  let store: PostgresStore;
  let deps: CaseOpeningDeps;

  /** A stored document with an arrival recorded, the way ingest leaves one. */
  async function documentWithArrival(): Promise<{ documentId: string; orgId: string }> {
    const uploadId = randomUUID();
    const documentId = randomUUID();
    await admin.query(
      `insert into uploads (id, org_id, source, created_by) values ($1,$2,'web_upload',$3)`,
      [uploadId, orgId, userId],
    );
    await admin.query(
      `insert into documents (id, org_id, upload_id, sha256, byte_size, mime_type, storage_ref, filename)
       values ($1,$2,$3,$4,2048,'application/pdf',$5,'doc.pdf')`,
      [documentId, orgId, uploadId, Buffer.from(randomUUID().replace(/-/g, ''), 'hex'), `db://${documentId}`],
    );
    return { documentId, orgId };
  }

  function field(value: string): unknown {
    return { value, confidence: 0.97, source_page: 1, source_quote: value };
  }

  function notice(invoice: string): CaseOpeningReading {
    return {
      docType: 'deduction_notice',
      document: {
        claim_id: field(`DN-${invoice}`),
        invoice_number: field(invoice),
        deduction_total: field('$100.00'),
        deduction_date: field('09/14/2026'),
      },
    };
  }

  function remittance(invoice: string): CaseOpeningReading {
    return {
      docType: 'remittance_advice',
      document: {
        payment_reference: field(`ACH-${invoice}`),
        payment_date: field('09/15/2026'),
        payment_total: field('$400.00'),
        lines: [
          {
            invoice_number: field(invoice),
            gross_amount: field('$500.00'),
            net_amount: field('$400.00'),
          },
        ],
      },
    };
  }

  async function pairEvents(ids: readonly string[]) {
    const { rows } = await admin.query<{ deduction_id: string; payload: Record<string, unknown> }>(
      `select deduction_id::text, payload from deduction_events
        where event_type = 'case.possible_duplicate' and deduction_id = any($1::uuid[])
        order by id`,
      [ids],
    );
    return rows;
  }

  beforeAll(async () => {
    await admin.query(`create role ${loginRole} login noinherit password '${password}'`);
    await admin.query(`grant app_rw to ${loginRole} with inherit false, set true`);
    await admin.query(`grant app_ro to ${loginRole} with inherit false, set true`);
    const url = new URL(connectionString as string);
    url.username = loginRole;
    url.password = password;
    loginUrl = url.toString();

    await admin.query(`insert into organizations (id, slug, name) values ($1,$2,'F1')`, [orgId, slug]);
    await admin.query(`insert into org_settings (org_id) values ($1)`, [orgId]);
    await admin.query(`insert into users (id, email) values ($1,$2)`, [userId, email]);
    await admin.query(`insert into memberships (org_id, user_id, role) values ($1,$2,'analyst')`, [
      orgId,
      userId,
    ]);
    store = new PostgresStore({ connectionString: connectionString as string }, { orgId, userId });
    deps = { store };
  });

  afterAll(async () => {
    await store?.close();
    await closeAllPools();
    await admin.query(`drop role if exists ${loginRole}`).catch(() => undefined);
    await admin.end();
  });

  it('lists a notice and its later remittance line as a pair, which can then be merged', async () => {
    const invoice = `INV-${suffix}-A`;
    const noticed = await openCaseFromNotice(await documentWithArrival(), notice(invoice), deps);
    const read = await openCasesFromRemittance(await documentWithArrival(), remittance(invoice), deps);

    expect(read.lines.map((l) => l.outcome)).toEqual(['probable_duplicate']);
    const lineCase = read.opened[0]?.deductionId as string;

    const pairs = await store.possibleDuplicates({ deductionId: lineCase });
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.older.deductionId).toBe(noticed.deductionId);
    expect(pairs[0]?.newer.deductionId).toBe(lineCase);
    expect(pairs[0]?.basis).toEqual(['invoice_number', 'amount_cents', 'deduction_date']);

    // Named once, on the line's case, in `openCase`'s own shape.
    const events = await pairEvents([noticed.deductionId, lineCase]);
    expect(events).toEqual([
      {
        deduction_id: lineCase,
        payload: { of: noticed.deductionId, basis: ['invoice_number', 'amount_cents', 'deduction_date'] },
      },
    ]);

    // And the pair is answerable end to end: confirmed and merged, where before
    // the merge check answered `not_confirmed` because no pair existed.
    await store.recordDuplicateVerdict({
      deductionId: lineCase,
      otherDeductionId: noticed.deductionId,
      verdict: 'same',
      recordedBy: userId,
      merge: true,
    });
    const { rows } = await admin.query<{ id: string; state: string }>(
      `select id::text, state from deductions where id = any($1::uuid[])`,
      [[noticed.deductionId, lineCase]],
    );
    expect(rows.map((r) => r.state).sort()).toContain('merged');
  });

  it('leaves the reverse order as it was: the notice names the line, once', async () => {
    const invoice = `INV-${suffix}-B`;
    const read = await openCasesFromRemittance(await documentWithArrival(), remittance(invoice), deps);
    const lineCase = read.opened[0]?.deductionId as string;
    expect(read.lines.map((l) => l.outcome)).toEqual(['opened']);
    const noticed = await openCaseFromNotice(await documentWithArrival(), notice(invoice), deps);

    const events = await pairEvents([noticed.deductionId, lineCase]);
    expect(events).toHaveLength(1);
    expect(events[0]?.deduction_id).toBe(noticed.deductionId);
    expect(events[0]?.payload['of']).toBe(lineCase);

    const pairs = await store.possibleDuplicates({ deductionId: noticed.deductionId });
    expect(pairs.map((p) => [p.older.deductionId, p.newer.deductionId])).toEqual([
      [lineCase, noticed.deductionId],
    ]);
  });

  it('backfills a pair the old code left unnamed, and a second run writes nothing', async () => {
    // The line's case opened as the code before this fix opened it: the match
    // on `case.discovered`, and no `case.possible_duplicate` anywhere.
    const preFix: CaseOpeningDeps = {
      store: new Proxy(store, {
        get(target, property, receiver) {
          if (property === 'appendEvent') {
            return async (event: Parameters<PostgresStore['appendEvent']>[0]) => {
              if (event.eventType === 'case.possible_duplicate') return;
              await target.appendEvent(event);
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      }),
    };
    const invoice = `INV-${suffix}-C`;
    const noticed = await openCaseFromNotice(await documentWithArrival(), notice(invoice), deps);
    const read = await openCasesFromRemittance(await documentWithArrival(), remittance(invoice), preFix);
    const lineCase = read.opened[0]?.deductionId as string;
    expect(await store.possibleDuplicates({ deductionId: lineCase })).toEqual([]);
    expect(await pairEvents([noticed.deductionId, lineCase])).toEqual([]);

    const command = async (args: string[]) => {
      try {
        const { stdout } = await run(TSX, [`${ROOT}scripts/link-duplicates.ts`, ...args], {
          cwd: tmpdir(),
          env: { ...process.env, DATABASE_URL: loginUrl, DOTENV_CONFIG_QUIET: 'true' },
          timeout: 60_000,
        });
        return { code: 0, stdout };
      } catch (error) {
        const failed = error as { code?: number; stdout?: string; stderr?: string };
        return { code: failed.code ?? -1, stdout: `${failed.stdout ?? ''}${failed.stderr ?? ''}` };
      }
    };

    // A dry run lists it and writes nothing.
    const dry = await command(['--org', slug, '--as', email, '--dry-run']);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain(`would name ${lineCase} as a possible duplicate of ${noticed.deductionId}`);
    expect(await pairEvents([noticed.deductionId, lineCase])).toEqual([]);

    const first = await command(['--org', slug, '--as', email]);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('1 named, 0 already named, 0 refused');
    const events = await pairEvents([noticed.deductionId, lineCase]);
    expect(events).toHaveLength(1);
    expect(events[0]?.deduction_id).toBe(lineCase);
    expect(events[0]?.payload['of']).toBe(noticed.deductionId);
    expect(events[0]?.payload['basis']).toEqual(['invoice_number', 'amount_cents', 'deduction_date']);

    const pairs = await store.possibleDuplicates({ deductionId: lineCase });
    expect(pairs.map((p) => [p.older.deductionId, p.newer.deductionId])).toEqual([
      [noticed.deductionId, lineCase],
    ]);

    // Idempotent: nothing left to list, nothing written.
    const second = await command(['--org', slug, '--as', email]);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('0 named, 0 already named, 0 refused');
    expect(await pairEvents([noticed.deductionId, lineCase])).toHaveLength(1);

    // And the write itself refuses to double up if asked directly.
    const discoveredId = (
      await admin.query<{ id: string }>(
        `select id::text from deduction_events where deduction_id = $1 and event_type = 'case.discovered'`,
        [lineCase],
      )
    ).rows[0]?.id as string;
    await expect(
      store.namePossibleDuplicate({ discoveredEventId: discoveredId, of: noticed.deductionId, recordedBy: userId }),
    ).resolves.toBe('already_named');
    expect(await pairEvents([noticed.deductionId, lineCase])).toHaveLength(1);
  });

  it('refuses to name a pair the event never recorded', async () => {
    const invoice = `INV-${suffix}-D`;
    const read = await openCasesFromRemittance(await documentWithArrival(), remittance(invoice), deps);
    const lineCase = read.opened[0]?.deductionId as string;
    const discoveredId = (
      await admin.query<{ id: string }>(
        `select id::text from deduction_events where deduction_id = $1 and event_type = 'case.discovered'`,
        [lineCase],
      )
    ).rows[0]?.id as string;
    await expect(
      store.namePossibleDuplicate({ discoveredEventId: discoveredId, of: randomUUID(), recordedBy: userId }),
    ).rejects.toThrow(/records no probable match/);
  });
});
