import { notFound, redirect } from 'next/navigation'
import type { Metadata } from 'next'
import PortfolioShell from '../components/PortfolioShell'
import { createClient } from '../lib/supabase/server'
import { loadPortfolio } from '../lib/portfolio-db'
import { adoptDeploymentMedia } from '../lib/deployment-owner'
import { TOUR_STEPS } from '../lib/onboarding-tour'
import { seedStarterBlocks } from '../lib/starter-blocks'
import { adoptGoogleAvatar } from '../lib/google-avatar'
import { loadUsernameConfirmed, resolveUsernameRedirect } from '../lib/username-db'

// Applies to every server action used on this page (per Next's own docs), and
// is set for exactly one of them: `translateChunk`, which makes a blocking
// model call — possibly falling back across several models — inside one
// function. Some hosting plans default low enough that a slow model would be
// killed mid-chunk with a generic error instead of one of its real messages.
export const maxDuration = 60

export async function generateMetadata({
  params,
}: {
  params: Promise<{ username: string }>
}): Promise<Metadata> {
  const { username } = await params
  const supabase = await createClient()
  const portfolio = await loadPortfolio(supabase, username)

  if (!portfolio) return { title: 'Portfolio not found' }

  const { hero } = portfolio.content.en
  return {
    title: `${hero.name} — Portfolio`,
    description: hero.tagline,
  }
}

export default async function UserPortfolioPage({
  params,
  searchParams,
}: {
  params: Promise<{ username: string }>
  searchParams: Promise<{ preview?: string }>
}) {
  const { username } = await params
  const supabase = await createClient()
  const [{ data: auth }, loaded, { preview }] = await Promise.all([
    supabase.auth.getUser(),
    loadPortfolio(supabase, username),
    searchParams,
  ])

  // Covers both an unknown username and a draft belonging to someone else:
  // row level security hides unpublished portfolios, so this cannot be used
  // to tell the two apart. An address its owner moved away from in the last
  // 90 days leads to their new one first (migration 0018).
  if (!loaded) {
    const moved = await resolveUsernameRedirect(supabase, username)
    if (moved) redirect(`/${moved}${preview === '1' ? '?preview=1' : ''}`)
    notFound()
  }

  const isOwner = !!auth.user && auth.user.id === loaded.ownerId
  // Lets the owner see exactly what a visitor sees — no edit affordances —
  // without having to sign out. Meaningless for anyone else.
  const previewing = isOwner && preview === '1'

  let portfolio = loaded
  if (isOwner) {
    const adopted = await adoptDeploymentMedia(supabase, {
      portfolioId: loaded.portfolioId,
      username: loaded.username,
    })
    // A new account's starter copy only exists in `content`; the page reads
    // text from blocks. See starter-blocks.ts.
    const seeded = await seedStarterBlocks(supabase, {
      portfolioId: loaded.portfolioId,
      content: loaded.content,
      blockCount: Object.keys(loaded.blocks).length,
    })
    // The same first open also gives the owner their Google photo as the
    // portrait — only then, so removing it later is never undone.
    const avatar = seeded
      ? await adoptGoogleAvatar(supabase, {
          portfolioId: loaded.portfolioId,
          userId: loaded.ownerId,
          avatarUrl: auth.user?.user_metadata?.avatar_url ?? auth.user?.user_metadata?.picture,
          alt: loaded.content.en.hero.name,
        })
      : false
    if (adopted || seeded || avatar) portfolio = (await loadPortfolio(supabase, username)) ?? loaded
  }

  // Asked once, the first time a new owner opens their page — see UsernamePicker.
  const askUsername = isOwner && !previewing && !(await loadUsernameConfirmed(supabase, loaded.ownerId))

  return (
    <PortfolioShell
      portfolio={portfolio}
      editing={isOwner && !previewing}
      previewing={previewing}
      // Only ever true for the owner, in the real (non-preview) editor — a
      // visitor or the owner's own preview view never has anything to
      // dismiss, so there is nothing for them to see here. Comparing against
      // the *current* TOUR_STEPS.length (not a stored "seen" flag) is what
      // makes a step added later resurface the tour for someone who'd
      // already finished a shorter version of it — see migration 0015.
      // The tour waits until the address is chosen, so the two never overlap.
      showTour={isOwner && !previewing && !askUsername && portfolio.tourStep < TOUR_STEPS.length}
      askUsername={askUsername}
      initialTourStep={portfolio.tourStep}
    />
  )
}
