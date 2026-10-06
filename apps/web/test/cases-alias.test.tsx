import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));

import CasesPage from '../app/cases/page';

describe('/cases list entry point', () => {
  it('opens the existing case list and keeps its search and filter values', async () => {
    await expect(CasesPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('redirect:/');
    await expect(CasesPage({
      searchParams: Promise.resolve({ q: 'PO 123', state: 'classified', about: ['notice', 'invoice'] }),
    })).rejects.toThrow('redirect:/?q=PO+123&state=classified&about=notice&about=invoice');
  });
});
