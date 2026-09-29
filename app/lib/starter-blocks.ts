import type { SupabaseClient } from '@supabase/supabase-js'
import type { JSONContent } from '@tiptap/core'
import type { Lang, PortfolioContent } from './portfolio'
import { skillCategoryId } from './portfolio'
import { renderBlockHtml } from './editor/render-html'

/**
 * The text of a portfolio lives in `portfolio_blocks` (one row per field per
 * language), and the page reads it from there only. A new account, though, is
 * created with its starter copy ("Your headline goes here", "Your first
 * project", …) in `portfolios.content` — the old home of that text, still
 * where the structure lives. The migrations that copied `content` into blocks
 * (0005–0011) ran once, for the accounts that existed then; nothing did it for
 * an account created afterwards, so a new owner opened a page of empty boxes
 * and a visitor saw an almost blank page.
 *
 * `blocksFromContent` is those migrations' mapping in one place: every field
 * with text becomes a one-paragraph block under the same block_key and section
 * the migrations used.
 *
 * List items get **deterministic ids** (`seed-0`, `seed-1`, …) instead of the
 * random ones the editor creates, for two reasons: a second seed of the same
 * portfolio (two tabs loading at once) lands on the same keys and is ignored
 * by the unique constraint rather than duplicating every line; and both
 * languages share the same ids, so the translation planner reads the two
 * lists as translations of each other rather than as unrelated lists. A
 * random id is 8 base-36 characters and never contains "-", so these can't
 * collide with one.
 */

export type SeedRow = {
  section: string
  block_key: string
  lang: Lang
  sort_order: number
  content_json: JSONContent
  content_html: string
}

function doc(text: string): JSONContent {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }
}

const seedId = (i: number) => `seed-${i}`

export function blocksFromContent(content: Record<Lang, PortfolioContent>): SeedRow[] {
  const rows: SeedRow[] = []
  for (const lang of ['en', 'es'] as const) {
    const c = content[lang]
    if (!c) continue
    const add = (section: string, blockKey: string, text: string | undefined, sortOrder = 0) => {
      const value = (text ?? '').trim()
      if (!value) return
      const json = doc(value)
      rows.push({
        section,
        block_key: blockKey,
        lang,
        sort_order: sortOrder,
        content_json: json,
        content_html: renderBlockHtml(json),
      })
    }

    add('hero', 'hero.greeting', c.hero?.greeting)
    add('hero', 'hero.name', c.hero?.name)
    add('hero', 'hero.tagline', c.hero?.tagline)
    add('hero', 'hero.description', c.hero?.description)
    ;(c.stats ?? []).slice(0, 3).forEach((stat, i) => {
      add('hero', `stats.${i}.value`, stat?.value)
      add('hero', `stats.${i}.label`, stat?.label)
    })

    add('journey', 'journey.title', c.journey?.title)
    for (const chapter of c.journey?.chapters ?? []) {
      if (!chapter?.id) continue
      const base = `journey.chapters.${chapter.id}`
      add('journey', `${base}.tag`, chapter.tag)
      add('journey', `${base}.heading`, chapter.heading)
      add('journey', `${base}.body`, chapter.body)
    }

    add('projects', 'projects.title', c.projects?.title)
    add('projects', 'projects.subtitle', c.projects?.subtitle)
    add('projects', 'projects.ctaTitle', c.projects?.ctaTitle)
    add('projects', 'projects.ctaDescription', c.projects?.ctaDescription)
    for (const project of c.projects?.items ?? []) {
      if (!project?.id) continue
      const base = `projects.items.${project.id}`
      add('projects', `${base}.title`, project.title)
      add('projects', `${base}.year`, project.year)
      add('projects', `${base}.tag`, project.tag)
      ;(project.narrative ?? []).forEach((line, i) => add('projects', `${base}.narrative.${seedId(i)}`, line, i))
      ;(project.metrics ?? []).slice(0, 3).forEach((metric, i) => {
        add('projects', `${base}.metrics.${i}.label`, metric?.label)
        add('projects', `${base}.metrics.${i}.value`, metric?.value)
      })
      ;(project.tags ?? []).forEach((tag, i) => add('projects', `${base}.tags.${seedId(i)}`, tag, i))
    }

    add('skills', 'skills.title', c.skills?.title)
    add('skills', 'skills.subtitle', c.skills?.subtitle)
    ;(c.skills?.categories ?? []).forEach((category, i) => {
      const base = `skills.categories.${category?.id ?? skillCategoryId(i)}`
      add('skills', `${base}.category`, category?.category)
      ;(category?.skills ?? []).forEach((skill, j) => add('skills', `${base}.skills.${seedId(j)}`, skill, j))
    })
    ;(c.skills?.certs ?? []).forEach((cert, i) => {
      add('skills', `skills.certs.${seedId(i)}.title`, cert?.title, i)
      add('skills', `skills.certs.${seedId(i)}.issuer`, cert?.issuer, i)
    })

    add('contact', 'contact.title', c.contact?.title)
    add('contact', 'contact.subtitle', c.contact?.subtitle)
    ;(c.contact?.availableItems ?? []).forEach((item, i) =>
      add('contact', `contact.availableItems.${seedId(i)}`, item, i)
    )

    add('footer', 'footer.tagline', c.footer?.tagline)
    add('footer', 'footer.rights', c.footer?.rights)
  }
  return rows
}

/**
 * Seed a portfolio's blocks from its `content` — only when it has **no block
 * at all**. That's the one state an account can only be in if nothing ever
 * wrote a block for it: clearing a field keeps its row (with an empty
 * document), so an owner who emptied things on purpose is never refilled.
 *
 * Called when the owner opens their own page (the same spot and shape as
 * `adoptDeploymentMedia`), so it also repairs accounts created before this
 * existed, the first time their owner comes back. Returns whether it wrote
 * anything, so the caller knows to reload.
 */
export async function seedStarterBlocks(
  supabase: SupabaseClient,
  { portfolioId, content, blockCount }: { portfolioId: string; content: Record<Lang, PortfolioContent>; blockCount: number }
): Promise<boolean> {
  if (blockCount > 0) return false
  try {
    const rows = blocksFromContent(content).map((row) => ({ ...row, portfolio_id: portfolioId }))
    if (rows.length === 0) return false
    const { error } = await supabase
      .from('portfolio_blocks')
      .upsert(rows, { onConflict: 'portfolio_id,block_key,lang', ignoreDuplicates: true })
    if (error) {
      console.error('seedStarterBlocks failed', { portfolioId, error })
      return false
    }
    return true
  } catch (err) {
    // Never block the page over this: at worst the owner sees empty fields,
    // exactly as before.
    console.error('seedStarterBlocks threw', { portfolioId, err })
    return false
  }
}
