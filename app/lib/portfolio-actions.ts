'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from './supabase/server'
import type { Lang, PortfolioContent } from './portfolio'
import { MAX_BACKGROUND_VIDEOS, isPresetVideo } from './preset-media'
import { TOUR_STEPS } from './onboarding-tour'

// Caps exist so a malformed or hostile payload cannot store an unbounded
// document. They are generous enough that no real portfolio hits them.
const LIMITS = {
  short: 200,
  line: 1000,
  body: 5000,
  chapters: 20,
  projects: 30,
  narrative: 10,
  metrics: 3,
  tags: 12,
  categories: 12,
  skills: 30,
  certs: 20,
  stats: 3,
  contactItems: 10,
  socials: 6,
}

function text(value: unknown, max = LIMITS.line): string {
  return typeof value === 'string' ? value.slice(0, max).trim() : ''
}

function list<T>(value: unknown, max: number, map: (item: unknown, index: number) => T): T[] {
  return Array.isArray(value) ? value.slice(0, max).map(map) : []
}

function textList(value: unknown, max: number, maxLen = LIMITS.line): string[] {
  return list(value, max, (item) => text(item, maxLen)).filter(Boolean)
}

function id(value: unknown, fallback: string): string {
  const raw = text(value, 64)
  return /^[A-Za-z0-9_-]{1,64}$/.test(raw) ? raw : fallback
}

// Only http(s) survive, so a stored link can never become a javascript: URL.
// A bare domain (no scheme at all — the natural way to type one) gets
// `https://` prepended first, same normalization LinkPopover.tsx already
// applies for rich text links, rather than being rejected outright: without
// this, typing "linkedin.com/in/you" here silently saved as an empty string.
function url(value: unknown, max = LIMITS.line): string {
  const raw = text(value, max)
  if (!raw) return ''
  const normalized = /^(https?:\/\/|mailto:)/i.test(raw) ? raw : `https://${raw}`
  try {
    const parsed = new URL(normalized)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? normalized : ''
  } catch {
    return ''
  }
}

function email(value: unknown): string {
  const raw = text(value, LIMITS.short)
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw : ''
}

// Rebuilds the document field by field, so anything the client sends that is
// not part of the shape is simply not carried over.
function sanitize(input: unknown): PortfolioContent {
  const c = (input ?? {}) as Record<string, never>
  const hero = (c.hero ?? {}) as Record<string, unknown>
  const journey = (c.journey ?? {}) as Record<string, unknown>
  const projects = (c.projects ?? {}) as Record<string, unknown>
  const skills = (c.skills ?? {}) as Record<string, unknown>
  const contact = (c.contact ?? {}) as Record<string, unknown>
  const footer = (c.footer ?? {}) as Record<string, unknown>

  return {
    hero: {
      greeting: text(hero.greeting, LIMITS.short),
      name: text(hero.name, LIMITS.short),
      tagline: text(hero.tagline, LIMITS.line),
      description: text(hero.description, LIMITS.body),
    },
    stats: list(c.stats, LIMITS.stats, (item) => {
      const s = (item ?? {}) as Record<string, unknown>
      return { value: text(s.value, LIMITS.short), label: text(s.label, LIMITS.short) }
    }),
    journey: {
      title: text(journey.title, LIMITS.short),
      chapters: list(journey.chapters, LIMITS.chapters, (item, index) => {
        const ch = (item ?? {}) as Record<string, unknown>
        return {
          id: id(ch.id, `chapter-${index}`),
          tag: text(ch.tag, LIMITS.short),
          heading: text(ch.heading, LIMITS.line),
          body: text(ch.body, LIMITS.body),
        }
      }),
    },
    projects: {
      title: text(projects.title, LIMITS.short),
      subtitle: text(projects.subtitle, LIMITS.line),
      ctaTitle: text(projects.ctaTitle, LIMITS.short),
      ctaDescription: text(projects.ctaDescription, LIMITS.body),
      items: list(projects.items, LIMITS.projects, (item, index) => {
        const p = (item ?? {}) as Record<string, unknown>
        return {
          id: id(p.id, `project-${index}`),
          year: text(p.year, LIMITS.short),
          tag: text(p.tag, LIMITS.short),
          title: text(p.title, LIMITS.line),
          narrative: textList(p.narrative, LIMITS.narrative, LIMITS.body),
          metrics: list(p.metrics, LIMITS.metrics, (m) => {
            const metric = (m ?? {}) as Record<string, unknown>
            return {
              label: text(metric.label, LIMITS.short),
              value: text(metric.value, LIMITS.short),
            }
          }),
          tags: textList(p.tags, LIMITS.tags, LIMITS.short),
        }
      }),
    },
    skills: {
      title: text(skills.title, LIMITS.short),
      subtitle: text(skills.subtitle, LIMITS.line),
      categories: list(skills.categories, LIMITS.categories, (item, index) => {
        const cat = (item ?? {}) as Record<string, unknown>
        return {
          id: id(cat.id, `skillcat-${index}`),
          category: text(cat.category, LIMITS.short),
          skills: textList(cat.skills, LIMITS.skills, LIMITS.short),
        }
      }),
      certs: list(skills.certs, LIMITS.certs, (item) => {
        const cert = (item ?? {}) as Record<string, unknown>
        return { title: text(cert.title, LIMITS.line), issuer: text(cert.issuer, LIMITS.short) }
      }),
    },
    contact: {
      title: text(contact.title, LIMITS.short),
      subtitle: text(contact.subtitle, LIMITS.body),
      availableItems: textList(contact.availableItems, LIMITS.contactItems),
      email: email(contact.email),
      // `||`, not `&&`: an owner filling one field before the other (the
      // natural order — type the label, then go back for the URL) had the
      // whole entry silently deleted on save the moment only one was
      // filled in, which looked exactly like the field itself couldn't be
      // edited. Only a link with *neither* field ever filled in is dropped.
      socials: list(contact.socials, LIMITS.socials, (item) => {
        const s = (item ?? {}) as Record<string, unknown>
        return { label: text(s.label, LIMITS.short), url: url(s.url) }
      }).filter((s) => s.label || s.url),
    },
    footer: {
      tagline: text(footer.tagline, LIMITS.line),
      rights: text(footer.rights, LIMITS.short),
    },
  }
}

export async function savePortfolio(payload: {
  content: Record<Lang, unknown>
}): Promise<{ ok: true } | { ok: false; error: string }> {
  // Wrapped so this always resolves rather than ever rejecting — an
  // uncaught throw here used to leave EditBar's Save button stuck showing
  // "Saving…" forever, the same class of bug fixed in block-actions.ts's
  // upsertBlock (see its longer comment).
  try {
    const supabase = await createClient()

    // Checked here rather than relying on proxy.ts: the Next docs are
    // explicit that proxy coverage can be dropped by a matcher change
    // without warning.
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return { ok: false, error: 'You are not signed in.' }

    const content = {
      en: sanitize(payload.content?.en),
      es: sanitize(payload.content?.es),
    }

    if (!content.en.hero.name && !content.es.hero.name) {
      return { ok: false, error: 'Your name cannot be empty.' }
    }

    // Portfolios are always public — there is no draft/private state — so
    // every save also self-heals any row still carrying the old default of
    // false. The row filter is belt and braces — row level security
    // already restricts updates to the caller's own portfolio.
    const { error } = await supabase
      .from('portfolios')
      .update({ content, published: true })
      .eq('user_id', user.id)

    if (error) return { ok: false, error: error.message }

    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Unexpected error saving.' }
  }
}

const BUCKET = 'portfolio-media'

/**
 * Points the portfolio at a newly uploaded portrait. The file itself is
 * uploaded from the browser straight to storage, where the bucket policy
 * already restricts writes to the caller's own folder; this records it and
 * clears the previous one so a single portrait is kept.
 */
export async function savePortrait(
  storagePath: string,
  alt: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'You are not signed in.' }

  // Storage policies key off the first path segment, so a path outside the
  // caller's own folder could never have been written in the first place.
  if (!storagePath.startsWith(`${user.id}/`)) {
    return { ok: false, error: 'That file does not belong to your account.' }
  }

  const { data: portfolio } = await supabase
    .from('portfolios')
    .select('id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!portfolio) return { ok: false, error: 'Your portfolio is still being set up.' }

  const { data: previous } = await supabase
    .from('portfolio_media')
    .select('id, storage_path')
    .eq('portfolio_id', portfolio.id)
    .eq('kind', 'portrait')

  // Remove the old row first: the database allows only one portrait, so an
  // insert alongside a leftover row would be rejected.
  if (previous?.length) {
    await supabase
      .from('portfolio_media')
      .delete()
      .in('id', previous.map((row) => row.id))
    await supabase.storage.from(BUCKET).remove(previous.map((row) => row.storage_path))
  }

  const { error } = await supabase.from('portfolio_media').insert({
    portfolio_id: portfolio.id,
    kind: 'portrait',
    target_id: null,
    storage_path: storagePath,
    alt: alt.slice(0, 200),
  })

  if (error) return { ok: false, error: error.message }

  revalidatePath('/', 'layout')
  return { ok: true }
}

/**
 * Replaces the background videos with a selection from the presets that ship
 * with the site. Only presets are accepted: video is the heaviest asset here,
 * and letting every account store its own would exhaust the storage tier long
 * before anything else. Enforced here rather than only in the interface.
 */
export async function setBackgroundVideos(
  paths: string[]
): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'You are not signed in.' }

  const wanted = paths.slice(0, MAX_BACKGROUND_VIDEOS)
  if (wanted.some((path) => !isPresetVideo(path))) {
    return { ok: false, error: 'Backgrounds can only be chosen from the built-in set.' }
  }

  const { data: portfolio } = await supabase
    .from('portfolios')
    .select('id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!portfolio) return { ok: false, error: 'Your portfolio is still being set up.' }

  const { data: existing } = await supabase
    .from('portfolio_media')
    .select('id, storage_path')
    .eq('portfolio_id', portfolio.id)
    .eq('kind', 'background_video')

  // Clear first: the database caps background videos, so inserting alongside
  // the old rows would be rejected.
  if (existing?.length) {
    await supabase
      .from('portfolio_media')
      .delete()
      .in('id', existing.map((row) => row.id))

    // Anything that was not a preset predates this rule; drop the file too so
    // deselecting it actually frees the space.
    const orphaned = existing
      .map((row) => row.storage_path)
      .filter((path) => !isPresetVideo(path) && !path.startsWith('/'))
    if (orphaned.length) await supabase.storage.from(BUCKET).remove(orphaned)
  }

  if (wanted.length) {
    const { error } = await supabase.from('portfolio_media').insert(
      wanted.map((path, index) => ({
        portfolio_id: portfolio.id,
        kind: 'background_video',
        target_id: null,
        storage_path: path,
        alt: '',
        sort_order: index,
      }))
    )
    if (error) return { ok: false, error: error.message }
  }

  revalidatePath('/', 'layout')
  return { ok: true }
}

/**
 * Points a journey chapter at a newly uploaded photo, replacing any it had —
 * the database allows only one per chapter. Mirrors savePortrait.
 */
export async function saveChapterPhoto(
  chapterId: string,
  storagePath: string,
  alt: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'You are not signed in.' }

  if (!storagePath.startsWith(`${user.id}/`)) {
    return { ok: false, error: 'That file does not belong to your account.' }
  }

  const { data: portfolio } = await supabase
    .from('portfolios')
    .select('id')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!portfolio) return { ok: false, error: 'Your portfolio is still being set up.' }

  const { data: previous } = await supabase
    .from('portfolio_media')
    .select('id, storage_path')
    .eq('portfolio_id', portfolio.id)
    .eq('kind', 'chapter')
    .eq('target_id', chapterId)

  if (previous?.length) {
    await supabase.from('portfolio_media').delete().in('id', previous.map((row) => row.id))
    const owned = previous.map((row) => row.storage_path).filter((path) => !path.startsWith('/'))
    if (owned.length) await supabase.storage.from(BUCKET).remove(owned)
  }

  const { error } = await supabase.from('portfolio_media').insert({
    portfolio_id: portfolio.id,
    kind: 'chapter',
    target_id: chapterId,
    storage_path: storagePath,
    alt: alt.slice(0, 200),
  })
  if (error) return { ok: false, error: error.message }

  revalidatePath('/', 'layout')
  return { ok: true }
}

export async function removeChapterPhoto(
  chapterId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'You are not signed in.' }

  const { data: portfolio } = await supabase
    .from('portfolios')
    .select('id')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!portfolio) return { ok: false, error: 'Your portfolio is still being set up.' }

  const { data: rows } = await supabase
    .from('portfolio_media')
    .select('id, storage_path')
    .eq('portfolio_id', portfolio.id)
    .eq('kind', 'chapter')
    .eq('target_id', chapterId)

  if (rows?.length) {
    await supabase.from('portfolio_media').delete().in('id', rows.map((row) => row.id))
    const owned = rows.map((row) => row.storage_path).filter((path) => !path.startsWith('/'))
    if (owned.length) await supabase.storage.from(BUCKET).remove(owned)
  }

  revalidatePath('/', 'layout')
  return { ok: true }
}

/**
 * Attaches one file — the certificate itself, a PDF or a photo of it — to a
 * certification. A single-file container, same shape as a chapter photo: any
 * previous file is deleted (row and storage object) before the new one is
 * inserted, so "replace" is just another call to this.
 *
 * `certId` is the certification's block-list item id. Those ids are per
 * language (a paired block list isn't synced across EN/ES — see
 * usePairedBlockList), so the file follows the certification item it was
 * attached to rather than being shared between the two languages.
 */
export async function saveCertificationFile(
  certId: string,
  storagePath: string,
  alt: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const supabase = await createClient()

    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return { ok: false, error: 'You are not signed in.' }

    if (!storagePath.startsWith(`${user.id}/`)) {
      return { ok: false, error: 'That file does not belong to your account.' }
    }

    const { data: portfolio } = await supabase
      .from('portfolios')
      .select('id')
      .eq('user_id', user.id)
      .maybeSingle()
    if (!portfolio) return { ok: false, error: 'Your portfolio is still being set up.' }

    const { data: previous } = await supabase
      .from('portfolio_media')
      .select('id, storage_path')
      .eq('portfolio_id', portfolio.id)
      .eq('kind', 'certification')
      .eq('target_id', certId)

    if (previous?.length) {
      await supabase.from('portfolio_media').delete().in('id', previous.map((row) => row.id))
      const owned = previous.map((row) => row.storage_path).filter((path) => !path.startsWith('/'))
      if (owned.length) await supabase.storage.from(BUCKET).remove(owned)
    }

    const { error } = await supabase.from('portfolio_media').insert({
      portfolio_id: portfolio.id,
      kind: 'certification',
      target_id: certId,
      storage_path: storagePath,
      alt: alt.slice(0, 200),
    })
    if (error) return { ok: false, error: error.message }

    revalidatePath('/', 'layout')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not save that file.' }
  }
}

/**
 * Drops a certification's file, both the row and the stored object. Called
 * both by the owner's own "Remove file" control and by removing the whole
 * certification — the block-list removal only deletes that item's text
 * blocks, so without this the file would be orphaned under an id nothing can
 * reference again (see "Orphaned data on delete" in CLAUDE.md).
 */
export async function removeCertificationFile(
  certId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const supabase = await createClient()

    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return { ok: false, error: 'You are not signed in.' }

    const { data: portfolio } = await supabase
      .from('portfolios')
      .select('id')
      .eq('user_id', user.id)
      .maybeSingle()
    if (!portfolio) return { ok: false, error: 'Your portfolio is still being set up.' }

    const { data: rows } = await supabase
      .from('portfolio_media')
      .select('id, storage_path')
      .eq('portfolio_id', portfolio.id)
      .eq('kind', 'certification')
      .eq('target_id', certId)

    if (rows?.length) {
      await supabase.from('portfolio_media').delete().in('id', rows.map((row) => row.id))
      const owned = rows.map((row) => row.storage_path).filter((path) => !path.startsWith('/'))
      if (owned.length) await supabase.storage.from(BUCKET).remove(owned)
    }

    revalidatePath('/', 'layout')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not remove that file.' }
  }
}

const MAX_PROJECT_PHOTOS = 4

/**
 * Adds one photo to a project's gallery, up to the 4 the database allows.
 */
export async function addProjectPhoto(
  projectId: string,
  storagePath: string,
  alt: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'You are not signed in.' }

  if (!storagePath.startsWith(`${user.id}/`)) {
    return { ok: false, error: 'That file does not belong to your account.' }
  }

  const { data: portfolio } = await supabase
    .from('portfolios')
    .select('id')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!portfolio) return { ok: false, error: 'Your portfolio is still being set up.' }

  const { count } = await supabase
    .from('portfolio_media')
    .select('id', { count: 'exact', head: true })
    .eq('portfolio_id', portfolio.id)
    .eq('kind', 'project')
    .eq('target_id', projectId)

  if ((count ?? 0) >= MAX_PROJECT_PHOTOS) {
    return { ok: false, error: `A project can have at most ${MAX_PROJECT_PHOTOS} photos.` }
  }

  const { error } = await supabase.from('portfolio_media').insert({
    portfolio_id: portfolio.id,
    kind: 'project',
    target_id: projectId,
    storage_path: storagePath,
    alt: alt.slice(0, 200),
    sort_order: count ?? 0,
  })
  if (error) return { ok: false, error: error.message }

  revalidatePath('/', 'layout')
  return { ok: true }
}

export async function removeProjectPhoto(
  projectId: string,
  storagePath: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'You are not signed in.' }

  const { data: portfolio } = await supabase
    .from('portfolios')
    .select('id')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!portfolio) return { ok: false, error: 'Your portfolio is still being set up.' }

  const { error } = await supabase
    .from('portfolio_media')
    .delete()
    .eq('portfolio_id', portfolio.id)
    .eq('kind', 'project')
    .eq('target_id', projectId)
    .eq('storage_path', storagePath)
  if (error) return { ok: false, error: error.message }

  if (!storagePath.startsWith('/')) await supabase.storage.from(BUCKET).remove([storagePath])

  revalidatePath('/', 'layout')
  return { ok: true }
}

/**
 * Points an existing gallery row at a freshly rotated re-encode of the same
 * photo, in place — unlike addProjectPhoto/removeProjectPhoto, this keeps
 * sort_order untouched instead of shuffling the row to the end. The crop
 * position is cleared since it described a frame that no longer matches the
 * rotated dimensions.
 */
export async function replaceProjectPhoto(
  projectId: string,
  oldStoragePath: string,
  newStoragePath: string,
  alt: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'You are not signed in.' }

  if (!newStoragePath.startsWith(`${user.id}/`)) {
    return { ok: false, error: 'That file does not belong to your account.' }
  }

  const { data: portfolio } = await supabase
    .from('portfolios')
    .select('id')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!portfolio) return { ok: false, error: 'Your portfolio is still being set up.' }

  const { error } = await supabase
    .from('portfolio_media')
    .update({ storage_path: newStoragePath, alt: alt.slice(0, 200), position: null })
    .eq('portfolio_id', portfolio.id)
    .eq('kind', 'project')
    .eq('target_id', projectId)
    .eq('storage_path', oldStoragePath)
  if (error) return { ok: false, error: error.message }

  if (!oldStoragePath.startsWith('/')) await supabase.storage.from(BUCKET).remove([oldStoragePath])

  revalidatePath('/', 'layout')
  return { ok: true }
}

/**
 * Rewrites the gallery order for one project. The paths arrive in the order
 * the owner dragged them into; sort_order is what the public carousel and the
 * card's cover photo (the first one) read back.
 */
export async function reorderProjectPhotos(
  projectId: string,
  storagePaths: string[]
): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'You are not signed in.' }

  const { data: portfolio } = await supabase
    .from('portfolios')
    .select('id')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!portfolio) return { ok: false, error: 'Your portfolio is still being set up.' }

  for (const [index, storagePath] of storagePaths.entries()) {
    const { error } = await supabase
      .from('portfolio_media')
      .update({ sort_order: index })
      .eq('portfolio_id', portfolio.id)
      .eq('kind', 'project')
      .eq('target_id', projectId)
      .eq('storage_path', storagePath)
    if (error) return { ok: false, error: error.message }
  }

  revalidatePath('/', 'layout')
  return { ok: true }
}

/**
 * Sets the CSS object-position (e.g. "62% 35%") an image crops around,
 * chosen by dragging the crop frame over the photo. Works for any media row —
 * portrait, chapter, or project photo — since storage_path is unique per
 * portfolio.
 *
 * `positionMobile` is a second, independent focal point for a box that's a
 * different shape on mobile than on desktop (e.g. the hero portrait: square
 * below `md`, a tall rectangle from `md` up) — one position can't be right
 * for both shapes. Optional: omit it to leave the mobile column untouched,
 * which is what every caller without a dedicated mobile crop step still does.
 */
export async function saveMediaPosition(
  storagePath: string,
  position: string,
  positionMobile?: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const supabase = await createClient()

    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return { ok: false, error: 'You are not signed in.' }

    const { data: portfolio } = await supabase
      .from('portfolios')
      .select('id')
      .eq('user_id', user.id)
      .maybeSingle()
    if (!portfolio) return { ok: false, error: 'Your portfolio is still being set up.' }

    const update: { position: string; position_mobile?: string } = {
      position: position.slice(0, 50),
    }
    if (positionMobile !== undefined) update.position_mobile = positionMobile.slice(0, 50)

    const { error } = await supabase
      .from('portfolio_media')
      .update(update)
      .eq('portfolio_id', portfolio.id)
      .eq('storage_path', storagePath)
    if (error) return { ok: false, error: error.message }

    revalidatePath('/', 'layout')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not save that position.' }
  }
}

/**
 * Deletes every migrated rich-text block belonging to a project, in both
 * languages, plus its gallery photos (portfolio_media rows + storage files).
 * Called immediately when the owner removes a project (ProjectTimeline.tsx),
 * not deferred to Save — the project's own removal from the array is still
 * only persisted by the next Save (old draft system), but portfolio_blocks
 * and portfolio_media are separate tables that system never touches at all,
 * so without this call every one of a removed project's fields and photos
 * stayed orphaned forever, keyed by an id nothing could ever reference
 * again. Both languages' blocks are deleted since removeProject always
 * removes the project from both languages' arrays at once (updateBoth) —
 * the id is meant to be shared across languages, unlike a plain block list.
 */
export async function deleteProjectData(
  projectId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const supabase = await createClient()

    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return { ok: false, error: 'You are not signed in.' }

    const { data: portfolio } = await supabase
      .from('portfolios')
      .select('id')
      .eq('user_id', user.id)
      .maybeSingle()
    if (!portfolio) return { ok: false, error: 'Your portfolio is still being set up.' }

    const { error: blocksError } = await supabase
      .from('portfolio_blocks')
      .delete()
      .eq('portfolio_id', portfolio.id)
      .like('block_key', `projects.items.${projectId}.%`)
    if (blocksError) return { ok: false, error: blocksError.message }

    const { data: mediaRows } = await supabase
      .from('portfolio_media')
      .select('id, storage_path')
      .eq('portfolio_id', portfolio.id)
      .eq('kind', 'project')
      .eq('target_id', projectId)

    if (mediaRows?.length) {
      await supabase.from('portfolio_media').delete().in('id', mediaRows.map((row) => row.id))
      const owned = mediaRows.map((row) => row.storage_path).filter((path) => !path.startsWith('/'))
      if (owned.length) await supabase.storage.from(BUCKET).remove(owned)
    }

    revalidatePath('/', 'layout')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Unexpected error deleting project data.' }
  }
}

/**
 * Same cleanup as deleteProjectData, for a journey chapter: every migrated
 * block under journey.chapters.<id>.* in both languages, plus the chapter's
 * single photo (mirrors removeChapterPhoto's own media/storage cleanup).
 * Called immediately when the owner removes a chapter (Journey.tsx).
 */
export async function deleteChapterData(
  chapterId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const supabase = await createClient()

    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return { ok: false, error: 'You are not signed in.' }

    const { data: portfolio } = await supabase
      .from('portfolios')
      .select('id')
      .eq('user_id', user.id)
      .maybeSingle()
    if (!portfolio) return { ok: false, error: 'Your portfolio is still being set up.' }

    const { error: blocksError } = await supabase
      .from('portfolio_blocks')
      .delete()
      .eq('portfolio_id', portfolio.id)
      .like('block_key', `journey.chapters.${chapterId}.%`)
    if (blocksError) return { ok: false, error: blocksError.message }

    const { data: mediaRows } = await supabase
      .from('portfolio_media')
      .select('id, storage_path')
      .eq('portfolio_id', portfolio.id)
      .eq('kind', 'chapter')
      .eq('target_id', chapterId)

    if (mediaRows?.length) {
      await supabase.from('portfolio_media').delete().in('id', mediaRows.map((row) => row.id))
      const owned = mediaRows.map((row) => row.storage_path).filter((path) => !path.startsWith('/'))
      if (owned.length) await supabase.storage.from(BUCKET).remove(owned)
    }

    revalidatePath('/', 'layout')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Unexpected error deleting chapter data.' }
  }
}

/**
 * Deletes a skill category's migrated blocks — its `category` name field and
 * every skill in its nested list — under skills.categories.<id>.*. Unlike
 * project/chapter removal, Skills.tsx removes a category with `updateActive`
 * (only the language being viewed), so only that language's blocks are
 * deleted here too: deleting both would risk wiping the other language's
 * still-referenced category if its own array hasn't had the same removal
 * applied (categories aren't synced across languages the way projects and
 * chapters are — see LanguageContext's updateActive vs updateBoth).
 */
export async function deleteSkillCategoryData(
  categoryId: string,
  lang: Lang
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const supabase = await createClient()

    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return { ok: false, error: 'You are not signed in.' }

    const { data: portfolio } = await supabase
      .from('portfolios')
      .select('id')
      .eq('user_id', user.id)
      .maybeSingle()
    if (!portfolio) return { ok: false, error: 'Your portfolio is still being set up.' }

    const { error } = await supabase
      .from('portfolio_blocks')
      .delete()
      .eq('portfolio_id', portfolio.id)
      .eq('lang', lang)
      .like('block_key', `skills.categories.${categoryId}.%`)
    if (error) return { ok: false, error: error.message }

    revalidatePath('/', 'layout')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Unexpected error deleting category data.' }
  }
}

/**
 * Ends the onboarding tour for now (see OnboardingTour.tsx) — called two
 * ways: reaching the last step and clicking "Entendido"/"Finalizar" (you saw
 * all of it), or clicking "Saltear tour" from any step (you don't want to
 * see the rest either). Both mean the same thing to the database; only the
 * UI trigger differs.
 *
 * "For now" rather than "forever": this sets onboarding_tour_step to however
 * many steps exist *right now* (TOUR_STEPS.length) rather than a separate
 * seen/not-seen flag, which is what lets a step added later automatically
 * resurface the tour for someone who already finished it — see migration
 * 0015 for the bug this fixes and why a boolean couldn't. Reaching the end
 * of a longer tour later naturally raises this same number further; there's
 * no going back down except by an owner explicitly pausing mid-tour (see
 * pauseOnboardingTour), which is a strictly earlier position anyway.
 *
 * Wrapped in try/catch like the autosave-path actions even though this one
 * is not on that path: a failure here has no error UI of its own (the
 * card has already closed client-side by the time this is called), so an
 * uncaught throw would fail silently either way — catching just keeps that
 * failure from ever reaching the caller as a rejected promise.
 */
export async function finishOnboardingTour(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const supabase = await createClient()

    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return { ok: false, error: 'You are not signed in.' }

    const { error } = await supabase
      .from('portfolios')
      .update({ onboarding_tour_step: TOUR_STEPS.length })
      .eq('user_id', user.id)
    if (error) return { ok: false, error: error.message }

    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Unexpected error.' }
  }
}

/**
 * Closes the tour for now without finishing it — the small "X" ("Salir"),
 * as opposed to "Saltear" (finishOnboardingTour). Remembers which step the
 * owner was on, so the next time they load the editor the tour resumes
 * there instead of restarting at step 0. Never advances the step count past
 * where the owner actually is — that would make "Salir" indistinguishable
 * from "Saltear", which is exactly the distinction the owner asked for
 * between the two.
 */
export async function pauseOnboardingTour(
  step: number
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const supabase = await createClient()

    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return { ok: false, error: 'You are not signed in.' }

    const { error } = await supabase
      .from('portfolios')
      .update({ onboarding_tour_step: Math.max(0, Math.trunc(step)) })
      .eq('user_id', user.id)
    if (error) return { ok: false, error: error.message }

    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Unexpected error.' }
  }
}
