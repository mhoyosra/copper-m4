// Server-only Supabase client that can write. Refund cases change, and the
// tables are not writable with the publishable key, so this uses a secret key
// that only ever lives in server code and .env.local (never in the browser).
// Import it only from server code. Returns null when Supabase isn't set up,
// so the app falls back to demo data.
import { createClient } from "@supabase/supabase-js";

function config(): { url: string; key: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url, key } : null;
}

export function isSupabaseAdminConfigured(): boolean {
  return config() !== null;
}

export function createAdminClient() {
  const c = config();
  return c
    ? createClient(c.url, c.key, { auth: { persistSession: false } })
    : null;
}
