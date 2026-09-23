import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PostgresStore } from '@recouple/store-postgres';

/**
 * The coverage page as a route: which reads it makes, for whom, and that a
 * failed read is an error rather than an empty page.
 */

const harness = vi.hoisted(() => ({
  role: 'read_only' as string,
  coverageCalls: 0,
  ledgerCalls: 0,
  closed: 0,
  fail: false,
}));

vi.mock('../lib/session', () => ({
  requireSession: async () => ({
    userId: '22222222-2222-2222-2222-222222222222',
    email: 'reader@example.test',
    org: { orgId: '11111111-1111-1111-1111-111111111111', slug: 'acme', name: 'Acme', role: harness.role },
    orgs: [],
  }),
  storeFor: () =>
    ({
      async coverageReport() {
        harness.coverageCalls += 1;
        if (harness.fail) throw new Error('database unreachable');
        return {
          months: 12,
          fromMonth: '2025-10-01',
          currentMonth: '2026-09-01',
          bySource: [],
          trailing: [],
          totals: [],
          countedTwice: { cases: 0, cents: 0, byChannel: [], listed: [] },
        };
      },
      async ledgerSyncHealth() {
        harness.ledgerCalls += 1;
        return { runs: [], findings: [] };
      },
      async close() {
        harness.closed += 1;
      },
    }) as unknown as PostgresStore,
}));

const CoverageRoute = (await import('../app/coverage/page')).default;

beforeEach(() => {
  Object.assign(harness, { role: 'read_only', coverageCalls: 0, ledgerCalls: 0, closed: 0, fail: false });
});

describe('/coverage', () => {
  it('reads each once and renders for a read-only member', async () => {
    const html = renderToStaticMarkup(await CoverageRoute());
    expect(harness.coverageCalls).toBe(1);
    expect(harness.ledgerCalls).toBe(1);
    expect(harness.closed).toBe(1);
    expect(html).toContain('What we found. What we filed.');
    // The shell marks the page it is on.
    expect(html).toContain('<a class="nav-item active" aria-current="page" href="/coverage">');
  });

  it('throws a failed read rather than rendering nothing, and still closes the store', async () => {
    harness.fail = true;
    await expect(CoverageRoute()).rejects.toThrow('database unreachable');
    expect(harness.closed).toBe(1);
  });
});
