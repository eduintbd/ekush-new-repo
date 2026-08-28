import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { authTimeoutFetch } from "./resilience";

export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // Auth calls get a deadline — a hung GoTrue must not hold the request
      // open until the gateway 504s. See ./resilience.ts.
      global: { fetch: authTimeoutFetch() },
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Server Component context — set is a no-op. Middleware refreshes.
          }
        },
      },
    },
  );
}
