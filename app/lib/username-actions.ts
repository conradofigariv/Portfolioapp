'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from './supabase/server'
import { normalizeUsernameInput, usernameProblem } from './username'

/**
 * Choosing and changing the portfolio's address — see migration 0018 for the
 * rules (an old address redirects for 90 days, then anyone can take it).
 */

export type UsernameStatus = 'available' | 'current' | 'taken' | 'invalid' | 'reserved'

export type UsernameCheck = { ok: true; username: string; status: UsernameStatus } | { ok: false; error: string }

/** Live check for the picker, as the owner types. Reads only public data. */
export async function checkUsername(raw: string): Promise<UsernameCheck> {
  try {
    const username = normalizeUsernameInput(typeof raw === 'string' ? raw : '')
    const problem = usernameProblem(username)
    if (problem) return { ok: true, username, status: problem }

    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return { ok: false, error: 'not_signed_in' }

    const { data: holder } = await supabase.from('profiles').select('id').eq('username', username).maybeSingle()
    if (holder) return { ok: true, username, status: holder.id === user.id ? 'current' : 'taken' }

    // An address someone moved away from less than 90 days ago still leads to
    // them. Missing table (migration not run yet) reads as "no redirects".
    const { data: redirect } = await supabase
      .from('username_redirects')
      .select('user_id')
      .eq('old_username', username)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle()
    if (redirect && redirect.user_id !== user.id) return { ok: true, username, status: 'taken' }

    return { ok: true, username, status: 'available' }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'check_failed' }
  }
}

export type UsernameChange = { ok: true; username: string } | { ok: false; error: string }

/**
 * Keep (confirm) or change the address. The whole change runs in the
 * database's change_username() so it's one transaction; this only validates
 * the input first and maps the result.
 */
export async function changeUsername(raw: string): Promise<UsernameChange> {
  try {
    const username = normalizeUsernameInput(typeof raw === 'string' ? raw : '')
    const problem = usernameProblem(username)
    if (problem) return { ok: false, error: problem }

    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return { ok: false, error: 'not_signed_in' }

    const { data: before } = await supabase.from('profiles').select('username').eq('id', user.id).maybeSingle()

    const { data, error } = await supabase.rpc('change_username', { new_name: username })
    if (error) {
      // PGRST202: the function doesn't exist — migration 0018 hasn't been run.
      if (error.code === 'PGRST202' || /change_username/.test(error.message)) {
        return { ok: false, error: 'migration_missing' }
      }
      return { ok: false, error: error.message }
    }
    if (data !== 'ok') return { ok: false, error: typeof data === 'string' ? data : 'unknown' }

    if (before?.username) revalidatePath(`/${before.username}`)
    revalidatePath(`/${username}`)
    return { ok: true, username }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'change_failed' }
  }
}
