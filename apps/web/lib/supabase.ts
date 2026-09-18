import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { env } from './env';

/**
 * A Supabase client for the current request, holding only the publishable key.
 *
 * Auth is all it is for. The database is never reached through it: reads and
 * writes go through `PostgresStore` as `app_rw` with the tenant's claims set,
 * which is where the RLS policies and the approval gate live. The service-role
 * key does not appear in this app at all (invariant 6).
 */
export async function supabaseForRequest() {
  const store = await cookies();
  return createServerClient(env.supabaseUrl, env.supabasePublishableKey, {
    cookies: {
      getAll() {
        return store.getAll();
      },
      setAll(toSet) {
        for (const { name, value, options } of toSet) {
          try {
            store.set(name, value, options);
          } catch {
            // Server components cannot set cookies; the middleware and route
            // handlers that can are where a refreshed session gets written.
          }
        }
      },
    },
  });
}
