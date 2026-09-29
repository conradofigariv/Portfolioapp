'use server'

import { cookies } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { createClient } from './supabase/server'
import { isTestAccount, resetPortfolioToNew, startCookieName } from './test-account'

/**
 * Puts a **test account** back exactly where a brand-new account starts: the
 * starter copy, no blocks (the next open seeds them), no photos or files, the
 * tour from its first step, the address not yet confirmed, and the "how do you
 * want to start?" screen not yet answered. The address itself is kept, so the
 * URL doesn't change under the owner.
 *
 * Refused for anything but a test account (see test-account.ts): on a real
 * account this would delete a whole portfolio. Every step only ever touches
 * the caller's own rows and folder — row level security and the bucket's
 * policies enforce that on top of the filters here.
 */
export async function resetTestAccount(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return { ok: false, error: 'You are not signed in.' }
    if (!isTestAccount(user)) return { ok: false, error: 'Only test accounts can be reset.' }

    const reset = await resetPortfolioToNew(supabase, user)
    if (!reset.ok) return reset

    ;(await cookies()).delete(startCookieName(user.id))
    revalidatePath('/', 'layout')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not reset the account.' }
  }
}
