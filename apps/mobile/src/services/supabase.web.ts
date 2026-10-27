import { createClient } from '@supabase/supabase-js';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export const isSupabaseConfigured = Boolean(url && publishableKey);
export const supabase = isSupabaseConfigured
  ? createClient(url!, publishableKey!, {
      auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true },
    })
  : null;

export async function verifyCurrentPassword(userId: string, email: string, password: string): Promise<boolean> {
  if (!url || !publishableKey) throw new Error('APMS is not connected.');
  const baseUrl = url.replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: publishableKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) {
    if (response.status === 400 || response.status === 401) return false;
    throw new Error('Supabase could not verify the current password. Try again.');
  }
  const session = await response.json() as { access_token?: string; user?: { id?: string } };
  const matchesCurrentUser = session.user?.id === userId;
  if (session.access_token) {
    await fetch(`${baseUrl}/auth/v1/logout?scope=local`, {
      method: 'POST',
      headers: { apikey: publishableKey, Authorization: `Bearer ${session.access_token}` },
    }).catch(() => undefined);
  }
  return matchesCurrentUser;
}
