import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AlwaysCleanScanner, InMemoryStore } from '@recouple/pipeline/testing';
import { ingestCaptures, type Capture } from '../src/index';
import { serialiseSnapshot } from '../src/runner/snapshot';

const ORG = '11111111-1111-1111-1111-111111111111';
const pdf = new Uint8Array(readFileSync(new URL('./fixture-portal/export.pdf', import.meta.url)));
const html = new TextEncoder().encode(serialiseSnapshot(readFileSync(new URL('./fixture-portal/deductions.html', import.meta.url), 'utf8'), 'jane'));

describe('ingestCaptures', () => {
  it('stores a snapshot as text/html and a download by its bytes, both portal_fetch with no member', async () => {
    const store = new InMemoryStore();
    const captures: Capture[] = [
      { kind: 'page_snapshot', stepName: 'list', filename: 'list.html', bytes: html, mimeType: 'text/html' },
      { kind: 'download', stepName: 'export', filename: 'export.pdf', bytes: pdf, mimeType: 'application/pdf' },
    ];
    const results = await ingestCaptures(captures, ORG, { store, scanner: new AlwaysCleanScanner() });
    expect(results.map((r) => r.document.mimeType)).toEqual(['text/html', 'application/pdf']);
    expect([...store.uploads.values()].map((u) => [u.source, u.createdBy])).toEqual([['portal_fetch', undefined], ['portal_fetch', undefined]]);
  });

  it('never lets a download that claims to be HTML through the snapshot door', async () => {
    const store = new InMemoryStore();
    const results = await ingestCaptures([{ kind: 'download', stepName: 'x', filename: 'page.html', bytes: html, mimeType: 'text/html' }], ORG, { store, scanner: new AlwaysCleanScanner() })
      .catch((e: unknown) => e);
    expect(results).toBeInstanceOf(Error);
    expect(store.uploads.size).toBe(0);
  });
});
