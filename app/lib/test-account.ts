import type { SupabaseClient, User } from '@supabase/supabase-js'
import { starterContent } from './starter-content'

const BUCKET = 'portfolio-media'

/**
 * Test accounts: users signed in with email + password (`/auth/test-login`), created
 * by hand in Supabase (Authentication → Users → Add user). Real accounts only
 * ever sign in with Google, so the provider alone tells them apart — which is
 * what lets a test account be reset to a brand-new one (see
 * test-account-actions.ts) and run the whole onboarding again without a new
 * Google account each time.
 *
 * If email sign-in is ever opened to the public, this has to become an
 * allowlist instead.
 */
export function isTestAccount(user: Pick<User, 'app_metadata'> | null | undefined): boolean {
  return user?.app_metadata?.provider === 'email'
}

/**
 * The cookie that remembers the owner's answer to "how do you want to start?"
 * (StartScreen.tsx). A cookie rather than a column: the server needs it to
 * decide what the page shows, and a new owner who never answered on another
 * device, with a portfolio still untouched, reasonably gets asked there too.
 */
export function startCookieName(userId: string): string {
  return `pa_start_${userId.replace(/[^a-zA-Z0-9]/g, '')}`
}

/**
 * The work behind `resetTestAccount` (test-account-actions.ts, which does the
 * auth and the test-account check): delete every file, media row and block of
 * the caller's portfolio, put the starter copy back, restart the tour and ask
 * for the address again. Takes the client so it's checked offline.
 */
export async function resetPortfolioToNew(
  supabase: SupabaseClient,
  user: Pick<User, 'id' | 'email' | 'user_metadata'>
): Promise<{ ok: true } | { ok: false; error: string }> {
  const [{ data: portfolio }, { data: profile }] = await Promise.all([
    supabase.from('portfolios').select('id').eq('user_id', user.id).maybeSingle(),
    supabase.from('profiles').select('display_name').eq('id', user.id).maybeSingle(),
  ])
  if (!portfolio) return { ok: false, error: 'Your portfolio is still being set up.' }

  // Files: every row's file plus anything else left in the folder (a CV
  // read for import and never kept, for one).
  const { data: media } = await supabase.from('portfolio_media').select('storage_path').eq('portfolio_id', portfolio.id)
  const { data: listed } = await supabase.storage.from(BUCKET).list(user.id, { limit: 1000 })
  const files = new Set<string>([
    ...(media ?? []).map((row) => row.storage_path as string).filter((path) => !path.startsWith('/')),
    ...(listed ?? []).filter((file) => file.name && file.id).map((file) => `${user.id}/${file.name}`),
  ])

  const { error: mediaError } = await supabase.from('portfolio_media').delete().eq('portfolio_id', portfolio.id)
  if (mediaError) return { ok: false, error: mediaError.message }
  if (files.size) await supabase.storage.from(BUCKET).remove([...files])

  const { error: blocksError } = await supabase.from('portfolio_blocks').delete().eq('portfolio_id', portfolio.id)
  if (blocksError) return { ok: false, error: blocksError.message }

  const name =
    (profile?.display_name as string | null) ||
    (user.user_metadata?.full_name as string | undefined) ||
    user.email?.split('@')[0] ||
    'Test'
  const { error: contentError } = await supabase
    .from('portfolios')
    .update({ content: starterContent(name), published: true, onboarding_tour_step: 0 })
    .eq('id', portfolio.id)
  if (contentError) return { ok: false, error: contentError.message }

  // Best effort: before migration 0018 there's no such column, and the
  // address picker then never asks anyway.
  await supabase.from('profiles').update({ username_confirmed: false }).eq('id', user.id)

  return { ok: true }
}
