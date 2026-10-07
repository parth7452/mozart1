import { redirect } from 'next/navigation';

/** Keep the /cases entry point pointing at the existing, RLS-scoped list. */
export default async function CasesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (Array.isArray(value)) {
      for (const item of value) query.append(key, item);
    } else if (value !== undefined) {
      query.append(key, value);
    }
  }
  redirect(query.size === 0 ? '/' : `/?${query.toString()}`);
}
