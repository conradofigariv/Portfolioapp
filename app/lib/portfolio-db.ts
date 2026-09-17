import type { SupabaseClient } from '@supabase/supabase-js'
import type { JSONContent } from '@tiptap/core'
import type {
  Lang,
  MediaImage,
  Portfolio,
  PortfolioBlocks,
  PortfolioContent,
  PortfolioMedia,
} from './portfolio'
import { skillCategoryId } from './portfolio'

const BUCKET = 'portfolio-media'

type MediaRow = {
  kind: string
  target_id: string | null
  storage_path: string
  alt: string
  sort_order: number
  position: string | null
  position_mobile: string | null
}

type BlockRow = {
  block_key: string
  lang: string
  content_json: JSONContent
  content_html: string
  sort_order: number
  updated_at: string
}

function buildBlocks(rows: BlockRow[]): PortfolioBlocks {
  const blocks: PortfolioBlocks = {}
  for (const row of rows) {
    if (row.lang !== 'en' && row.lang !== 'es') continue
    blocks[row.block_key] ??= {}
    blocks[row.block_key][row.lang] = {
      json: row.content_json,
      html: row.content_html,
      updatedAt: row.updated_at,
      sortOrder: row.sort_order,
    }
  }
  return blocks
}

// Content is stored as one JSONB document per portfolio, so a page render is a
// single row read rather than a join across a table per section.
function isContent(value: unknown): value is PortfolioContent {
  if (!value || typeof value !== 'object') return false
  const c = value as Partial<PortfolioContent>
  return !!c.hero && !!c.projects && !!c.journey && !!c.skills
}

// Back-fills fields added after some documents were already saved, so an
// older stored portfolio does not crash the page it renders on — the schema
// is a JSONB column with no migration to run for a purely additive field.
function normalizeContent(raw: PortfolioContent): PortfolioContent {
  const contact = raw.contact as Partial<PortfolioContent['contact']> | undefined
  return {
    ...raw,
    skills: {
      ...raw.skills,
      // Categories predating the `id` field (assigned by 0010's migration
      // to every already-stored category) get the same deterministic
      // index-based id here — a belt-and-suspenders fallback in case this
      // ever renders a document the migration hasn't reached yet, so a
      // category's block_key is never built from an undefined id.
      categories: raw.skills.categories.map((cat, i) => ({ ...cat, id: cat.id ?? skillCategoryId(i) })),
    },
    contact: {
      title: contact?.title ?? '',
      subtitle: contact?.subtitle ?? '',
      availableItems: Array.isArray(contact?.availableItems) ? contact.availableItems : [],
      email: contact?.email ?? '',
      socials: Array.isArray(contact?.socials) ? contact.socials : [],
    },
  }
}

function buildMedia(rows: MediaRow[], publicUrl: (path: string) => string): PortfolioMedia {
  const media: PortfolioMedia = {
    portrait: null,
    backgroundVideos: [],
    cv: null,
    projectImages: {},
    chapterPhotos: {},
  }

  for (const row of [...rows].sort((a, b) => a.sort_order - b.sort_order)) {
    // A path is either an object in storage or, for media shipped with the
    // deployment itself, a file served straight from /public.
    const url = row.storage_path.startsWith('/')
      ? row.storage_path
      : publicUrl(row.storage_path)
    const image: MediaImage = {
      src: url,
      alt: row.alt,
      position: row.position ?? undefined,
      positionMobile: row.position_mobile ?? undefined,
    }

    switch (row.kind) {
      case 'portrait':
        media.portrait = image
        break
      case 'background_video':
        media.backgroundVideos.push(url)
        break
      case 'cv':
        media.cv = url
        break
      case 'project':
        if (row.target_id) {
          media.projectImages[row.target_id] ??= []
          media.projectImages[row.target_id].push(image)
        }
        break
      case 'chapter':
        if (row.target_id) media.chapterPhotos[row.target_id] = image
        break
    }
  }

  return media
}

// Returns null when the username does not exist, or when the portfolio is still
// a draft and the viewer is not its owner — row level security decides that, so
// this cannot leak someone else's unpublished work.
export async function loadPortfolio(
  supabase: SupabaseClient,
  username: string
): Promise<
  | (Portfolio & {
      published: boolean
      ownerId: string
      portfolioId: string
      // Onboarding tour progress (see OnboardingTour.tsx) — meaningless for
      // anyone but the owner; the page only ever reads this behind an
      // isOwner check. How many steps the owner has gotten through, either
      // by pausing mid-tour ("Salir", resumes exactly here) or by finishing
      // ("Entendido"/"Saltear", set to however many steps existed at that
      // moment — see finishOnboardingTour). The caller compares this against
      // the *current* TOUR_STEPS.length to decide whether to show the tour
      // at all, so a step added later automatically resurfaces it for anyone
      // who'd already finished a shorter version.
      tourStep: number
    })
  | null
> {
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, username')
    .eq('username', username.toLowerCase())
    .maybeSingle()

  if (!profile) return null

  const { data: portfolio } = await supabase
    .from('portfolios')
    .select('id, content, published, onboarding_tour_step')
    .eq('user_id', profile.id)
    .maybeSingle()

  if (!portfolio) return null

  const content = portfolio.content as Partial<Record<Lang, unknown>> | null
  if (!content || !isContent(content.en) || !isContent(content.es)) return null

  const { data: mediaRows } = await supabase
    .from('portfolio_media')
    .select('kind, target_id, storage_path, alt, sort_order, position, position_mobile')
    .eq('portfolio_id', portfolio.id)

  const { data: blockRows } = await supabase
    .from('portfolio_blocks')
    .select('block_key, lang, content_json, content_html, sort_order, updated_at')
    .eq('portfolio_id', portfolio.id)

  const publicUrl = (path: string) => supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl

  return {
    username: profile.username,
    media: buildMedia((mediaRows ?? []) as MediaRow[], publicUrl),
    content: { en: normalizeContent(content.en), es: normalizeContent(content.es) },
    blocks: buildBlocks((blockRows ?? []) as BlockRow[]),
    published: !!portfolio.published,
    ownerId: profile.id,
    portfolioId: portfolio.id,
    tourStep: typeof portfolio.onboarding_tour_step === 'number' ? portfolio.onboarding_tour_step : 0,
  }
}

export function hasAnyMedia(media: PortfolioMedia): boolean {
  return (
    !!media.portrait ||
    !!media.cv ||
    media.backgroundVideos.length > 0 ||
    Object.keys(media.projectImages).length > 0 ||
    Object.keys(media.chapterPhotos).length > 0
  )
}
