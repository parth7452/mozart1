import { redirect } from 'next/navigation';

/**
 * `/cases/new` is a link to the dialog over the deductions list (ADR 0070),
 * not a page of its own: the query string is kept, so an echoed form survives.
 */
export default async function NewCasePage({
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
  redirect(query.size === 0 ? '/#new-case' : `/?${query.toString()}#new-case`);
}
