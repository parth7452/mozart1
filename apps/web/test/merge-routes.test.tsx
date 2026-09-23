import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  CaseNotVisibleError,
  MergeRefusedError,
  WrongRoleError,
  type MergeRecord,
  type UnmergeRecord,
} from '@recouple/pipeline';
import type { PostgresStore } from '@recouple/store-postgres';
import { NOTICE_ABOUT_PARAM, resolveNotice } from '../lib/notices';

/**
 * The Merge button and the undo (ADR 0042).
 *
 * Both change two money-bearing cases, so what is tested is the order of the
 * checks, that the acting person is the session and never the form, that a
 * case this tenant cannot see is a 404, and that every named refusal says
 * nothing changed while anything unnamed fails loud. The real store is tested
 * against Postgres in `packages/store-postgres/test/duplicate-merge.test.ts`.
 */
const ORG_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const CASE_ID = '33333333-3333-3333-3333-333333333333';
const OTHER_ID = '44444444-4444-4444-4444-444444444444';

class RouteTestStore {
  closed = 0;
  mayWrite = true;
  readonly asked: unknown[] = [];
  readonly merges: unknown[] = [];
  readonly undos: unknown[] = [];
  throws: unknown;

  async memberMayWrite(actor: { orgId: string; userId: string }): Promise<boolean> {
    this.asked.push(actor);
    return this.mayWrite;
  }

  async mergeConfirmedDuplicate(input: {
    deductionId: string;
    otherDeductionId: string;
    mergedBy: string;
  }): Promise<MergeRecord> {
    this.merges.push(input);
    if (this.throws !== undefined) throw this.throws;
    return {
      mergeId: '55555555-5555-5555-5555-555555555555',
      mergedDeductionId: input.otherDeductionId,
      survivingDeductionId: input.deductionId,
      stateBefore: 'classified',
      recordedBy: input.mergedBy,
      recordedAt: '2026-09-23T09:00:00.000Z',
    };
  }

  async undoMerge(input: { deductionId: string; undoneBy: string }): Promise<UnmergeRecord> {
    this.undos.push(input);
    if (this.throws !== undefined) throw this.throws;
    return {
      unmergeId: '66666666-6666-6666-6666-666666666666',
      mergedDeductionId: input.deductionId,
      survivingDeductionId: OTHER_ID,
      restoredState: 'classified',
      recordedBy: input.undoneBy,
      recordedAt: '2026-09-23T09:00:00.000Z',
    };
  }

  async close(): Promise<void> {
    this.closed += 1;
  }
}

const harness = vi.hoisted(() => ({
  store: undefined as RouteTestStore | undefined,
  role: 'analyst' as string,
  sessions: 0,
}));

vi.mock('../lib/session', () => ({
  requireSession: async () => {
    harness.sessions += 1;
    return {
      userId: USER_ID,
      email: 'reviewer@example.test',
      org: { orgId: ORG_ID, slug: 'acme', name: 'Acme', role: harness.role },
      orgs: [],
    };
  },
  storeFor: () => harness.store as unknown as PostgresStore,
}));

vi.mock('../lib/pipeline', () => ({
  mayWrite: (role: string) => role !== 'read_only' && role !== 'accountant_guest',
}));

const { POST: merge } = await import('../app/cases/[id]/merge/route');
const { POST: unmerge } = await import('../app/cases/[id]/unmerge/route');

function post(
  path: 'merge' | 'unmerge',
  fields: Record<string, string> = { other: OTHER_ID },
  secFetchSite?: string,
): NextRequest {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const headers = new Headers();
  if (secFetchSite !== undefined) headers.set('sec-fetch-site', secFetchSite);
  return new NextRequest(`https://app.example.test/cases/${CASE_ID}/${path}`, {
    method: 'POST',
    body: form,
    headers,
  });
}

function params(id: string = CASE_ID): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function said(response: Response): string | undefined {
  const at = new URL(response.headers.get('location') as string);
  return resolveNotice(
    at.searchParams.get('action') ?? undefined,
    at.searchParams.getAll(NOTICE_ABOUT_PARAM),
  )?.text;
}

beforeEach(() => {
  harness.role = 'analyst';
  harness.sessions = 0;
  harness.store = new RouteTestStore();
});

describe('merging a confirmed pair from its case page', () => {
  it('merges as the session’s own user and says so', async () => {
    const store = harness.store as RouteTestStore;

    const response = await merge(post('merge', { other: OTHER_ID, mergedBy: OTHER_ID }), params());

    expect(response.status).toBe(303);
    expect(store.merges).toEqual([
      { deductionId: CASE_ID, otherDeductionId: OTHER_ID, mergedBy: USER_ID },
    ]);
    expect(new URL(response.headers.get('location') as string).pathname).toBe(`/cases/${CASE_ID}`);
    expect(said(response)).toMatch(/^merged:/);
    expect(store.closed).toBe(1);
  });

  it('refuses a cross-site post before it resolves the session', async () => {
    const response = await merge(post('merge', undefined, 'cross-site'), params());
    expect(response.status).toBe(403);
    expect(harness.sessions).toBe(0);
    expect((harness.store as RouteTestStore).merges).toEqual([]);
  });

  it('tells a read-only member no, and asks the store nothing', async () => {
    harness.role = 'read_only';
    const store = harness.store as RouteTestStore;
    const response = await merge(post('merge'), params());
    expect(said(response)).toMatch(/not merge them/);
    expect(store.asked).toEqual([]);
    expect(store.merges).toEqual([]);
  });

  it('asks the database as well, and writes nothing when it says no', async () => {
    const store = harness.store as RouteTestStore;
    store.mayWrite = false;
    const response = await merge(post('merge'), params());
    expect(store.asked).toEqual([{ orgId: ORG_ID, userId: USER_ID }]);
    expect(store.merges).toEqual([]);
    expect(said(response)).toMatch(/not merge them/);
  });

  it('refuses ids that are not UUIDs without reaching the store', async () => {
    const store = harness.store as RouteTestStore;
    const badPath = await merge(post('merge'), params('------------------------------------'));
    expect(new URL(badPath.headers.get('location') as string).pathname).toBe('/');
    for (const other of ['', 'not-a-uuid']) {
      expect(said(await merge(post('merge', { other }), params()))).toMatch(/not a pair/);
    }
    expect(said(await merge(post('merge', {}), params()))).toMatch(/not a pair/);
    expect(store.merges).toEqual([]);
  });

  it('404s a case this tenant cannot see', async () => {
    (harness.store as RouteTestStore).throws = new CaseNotVisibleError(CASE_ID);
    const response = await merge(post('merge'), params());
    expect(response.status).toBe(404);
  });

  it('says nothing changed when the database refuses, and when the role is refused by name', async () => {
    const store = harness.store as RouteTestStore;
    store.throws = new MergeRefusedError('both_filed', CASE_ID, OTHER_ID);
    expect(said(await merge(post('merge'), params()))).toMatch(/cannot be merged.*Nothing was changed/);
    store.throws = new WrongRoleError(USER_ID, 'merging a confirmed duplicate', ['owner']);
    expect(said(await merge(post('merge'), params()))).toMatch(/not merge them/);
  });

  it('fails loud on anything it does not recognise, and still closes the store', async () => {
    const store = harness.store as RouteTestStore;
    store.throws = new Error('the database blinked');
    await expect(merge(post('merge'), params())).rejects.toThrow('the database blinked');
    expect(store.closed).toBe(1);
  });
});

describe('undoing a merge', () => {
  it('undoes the merge of the case the path names, as the session’s own user', async () => {
    const store = harness.store as RouteTestStore;

    const response = await unmerge(post('unmerge', { undoneBy: OTHER_ID }), params());

    expect(store.undos).toEqual([{ deductionId: CASE_ID, undoneBy: USER_ID }]);
    expect(said(response)).toMatch(/^undone:/);
    expect(store.closed).toBe(1);
  });

  it('refuses cross-site, a reader, and a database that says no', async () => {
    expect((await unmerge(post('unmerge', {}, 'cross-site'), params())).status).toBe(403);

    harness.role = 'read_only';
    expect(said(await unmerge(post('unmerge', {}), params()))).toMatch(/not merge them or undo/);

    harness.role = 'analyst';
    const store = harness.store as RouteTestStore;
    store.mayWrite = false;
    expect(said(await unmerge(post('unmerge', {}), params()))).toMatch(/not merge them or undo/);
    expect(store.undos).toEqual([]);
  });

  it('says there is nothing to undo when the case is not merged', async () => {
    (harness.store as RouteTestStore).throws = new MergeRefusedError('not_merged', CASE_ID);
    expect(said(await unmerge(post('unmerge', {}), params()))).toMatch(/nothing to undo/);
  });

  it('404s a case this tenant cannot see, and fails loud on the unknown', async () => {
    const store = harness.store as RouteTestStore;
    store.throws = new CaseNotVisibleError(CASE_ID);
    expect((await unmerge(post('unmerge', {}), params())).status).toBe(404);
    store.throws = new Error('the database blinked');
    await expect(unmerge(post('unmerge', {}), params())).rejects.toThrow('the database blinked');
  });
});
