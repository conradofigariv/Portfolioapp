import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import PortfolioShell from '../components/PortfolioShell'
import { createClient } from '../lib/supabase/server'
import { loadPortfolio } from '../lib/portfolio-db'
import { adoptDeploymentMedia } from '../lib/deployment-owner'
import { TOUR_STEPS } from '../lib/onboarding-tour'

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
  // to tell the two apart.
  if (!loaded) notFound()

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
    if (adopted) portfolio = (await loadPortfolio(supabase, username)) ?? loaded
  }

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
      showTour={isOwner && !previewing && portfolio.tourStep < TOUR_STEPS.length}
      initialTourStep={portfolio.tourStep}
    />
  )
}
