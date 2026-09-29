import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Reads for the address feature (migration 0018). Both tolerate the migration
 * not having run yet — a deploy lands before anyone runs the SQL by hand, and
 * the page must keep working in between: no redirects, and nobody is asked to
 * choose an address.
 */

/** The current address of whoever moved away from `username` in the last 90 days, if anyone. */
export async function resolveUsernameRedirect(supabase: SupabaseClient, username: string): Promise<string | null> {
  try {
    const { data: redirect, error } = await supabase
      .from('username_redirects')
      .select('user_id')
      .eq('old_username', username.toLowerCase())
      .gt('expires_at', new Date().toISOString())
      .maybeSingle()
    if (error || !redirect) return null
    const { data: profile } = await supabase.from('profiles').select('username').eq('id', redirect.user_id).maybeSingle()
    return profile?.username && profile.username !== username.toLowerCase() ? profile.username : null
  } catch {
    return null
  }
}

/** Whether the owner has already kept or changed their address. Unknown reads as yes: never prompt by mistake. */
export async function loadUsernameConfirmed(supabase: SupabaseClient, userId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.from('profiles').select('username_confirmed').eq('id', userId).maybeSingle()
    if (error || !data) return true
    return data.username_confirmed !== false
  } catch {
    return true
  }
}

/** An address still leading to someone else — a new account mustn't be given it. */
export async function isHeldByRedirect(supabase: SupabaseClient, username: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('username_redirects')
      .select('old_username')
      .eq('old_username', username)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle()
    return !error && !!data
  } catch {
    return false
  }
}
