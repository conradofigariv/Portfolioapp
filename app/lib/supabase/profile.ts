import type { SupabaseClient, User } from '@supabase/supabase-js'
import { slugifyUsername, withSuffix } from '../username'
import { starterContent } from '../starter-content'
import { isHeldByRedirect } from '../username-db'

const UNIQUE_VIOLATION = '23505'
const CHECK_VIOLATION = '23514' // reserved username or bad format

// Creates a profile (and an empty draft portfolio) the first time a user signs
// in. Username is derived from their Google name/email and de-duplicated by
// retrying with -2, -3, ... on conflict. No-ops if the profile already exists.
export async function ensureProfile(supabase: SupabaseClient, user: User) {
  const { data: existing } = await supabase
    .from('profiles')
    .select('id')
    .eq('id', user.id)
    .maybeSingle()

  if (existing) return

  const seed =
    (user.user_metadata?.full_name as string | undefined) ||
    (user.user_metadata?.name as string | undefined) ||
    user.email?.split('@')[0] ||
    'user'
  const base = slugifyUsername(seed)
  const displayName = (user.user_metadata?.full_name as string | undefined) ?? null

  const MAX_ATTEMPTS = 25
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const username = withSuffix(base, attempt)
    // Someone who moved away from this address in the last 90 days still owns
    // where it leads (migration 0018): try the next suffix instead.
    if (await isHeldByRedirect(supabase, username)) continue
    const { error } = await supabase.from('profiles').insert({
      id: user.id,
      username,
      display_name: displayName,
      avatar_url: (user.user_metadata?.avatar_url as string | undefined) ?? null,
    })

    if (!error) {
      // Best-effort: a failure here leaves a profile without a portfolio row,
      // which the editor can create lazily on first save.
      await supabase.from('portfolios').insert({
        user_id: user.id,
        published: true,
        content: starterContent(displayName ?? seed),
      })
      return
    }

    if (error.code !== UNIQUE_VIOLATION && error.code !== CHECK_VIOLATION) {
      throw error
    }
  }

  throw new Error(`Could not allocate a username for user ${user.id} after ${MAX_ATTEMPTS} attempts`)
}
