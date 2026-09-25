import type { JSONContent } from '@tiptap/core'
import type { Lang, MediaImage, PortfolioBlocks, PortfolioContent, PortfolioMedia } from '../portfolio'

/**
 * The portfolio as the PDF export sees it: every field already resolved to
 * plain runs of text, every list already sorted, every empty thing already
 * dropped — so the document component (PortfolioDocument.tsx) is pure layout
 * and never has to know about block keys, languages or Tiptap.
 *
 * Pure and dependency-free on purpose: it's the one part of the export with
 * real logic in it (which key holds what, what order lists come in, what
 * counts as empty), and keeping it apart from react-pdf is what lets it be
 * checked offline against fixtures instead of only by eyeballing a PDF.
 *
 * It reads the same things the page does, the same way: the *structure*
 * (which chapters, projects and skill categories exist, in what order) from
 * `content`, and every piece of *text* from `blocks` in the active language —
 * see EditableText.tsx, which has no fallback to `content` either. A field
 * that's empty on the page is absent from the PDF.
 */

/** One run of text with the formatting that survives into print. */
export type Run = {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  href?: string
}
export type Rich = Run[]

/** An image to fetch and crop at export time. `aspect` is width / height. */
export type PdfImage = { src: string; alt: string; position?: string; aspect: number }

export type PdfModel = {
  lang: Lang
  /** The name as plain text — the file name and the running footer. */
  plainName: string
  /** The live portfolio's URL, printed in the footer as a link back. */
  url: string
  hero: { greeting: Rich; name: Rich; tagline: Rich; description: Rich; portrait: PdfImage | null }
  stats: { value: Rich; label: Rich }[]
  journey: {
    title: Rich
    chapters: { tag: Rich; heading: Rich; body: Rich; photo: PdfImage | null }[]
  }
  projects: {
    title: Rich
    subtitle: Rich
    items: {
      year: Rich
      tag: Rich
      title: Rich
      narrative: Rich[]
      metrics: { value: Rich; label: Rich }[]
      tags: Rich[]
      cover: PdfImage | null
    }[]
  }
  skills: {
    title: Rich
    subtitle: Rich
    categories: { name: Rich; skills: Rich[] }[]
    certs: { title: Rich; issuer: Rich }[]
  }
  contact: {
    title: Rich
    subtitle: Rich
    available: Rich[]
    email: string
    socials: { label: string; url: string }[]
  }
  closing: Rich
}

// Image boxes in the document, width / height. Kept here (not in the layout)
// because the export crops each photo to exactly this shape before it ever
// reaches react-pdf — see export.ts.
export const ASPECT = { portrait: 1, chapter: 3 / 2, project: 3 / 2 }

export function isEmptyRich(rich: Rich): boolean {
  return rich.every((run) => run.text.trim() === '')
}

export function plainText(rich: Rich): string {
  return rich
    .map((run) => run.text)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Tiptap JSON → runs. Keeps what reads the same on paper — bold, italic,
 * underline, strikethrough, links — and deliberately drops colour, highlight,
 * font size and font family: those were picked against the page's dark
 * background and its own type scale (a lime word is invisible on white, a
 * 60px heading size means nothing in a 10pt paragraph), and the document sets
 * its own. Paragraphs join with a space: every field is a single short
 * paragraph (Enter is disabled in the editor), so there's nothing to lay out.
 */
export function richFromDoc(doc: JSONContent | null | undefined): Rich {
  const runs: Rich = []
  if (!doc) return runs
  let paragraphs = 0
  const walk = (node: JSONContent) => {
    if (node.type === 'paragraph') {
      if (paragraphs++ > 0) runs.push({ text: ' ' })
    }
    if (node.type === 'hardBreak') {
      runs.push({ text: ' ' })
      return
    }
    if (typeof node.text === 'string') {
      const run: Run = { text: node.text }
      for (const mark of node.marks ?? []) {
        if (mark.type === 'bold') run.bold = true
        else if (mark.type === 'italic') run.italic = true
        else if (mark.type === 'underline') run.underline = true
        else if (mark.type === 'strike') run.strike = true
        else if (mark.type === 'link' && typeof mark.attrs?.href === 'string') run.href = mark.attrs.href
      }
      runs.push(run)
      return
    }
    node.content?.forEach(walk)
  }
  walk(doc)
  return trimRich(runs)
}

/** Leading/trailing whitespace off the whole field, not off each run. */
function trimRich(runs: Rich): Rich {
  const out = runs.map((run) => ({ ...run }))
  while (out.length && out[0].text.trim() === '') out.shift()
  while (out.length && out[out.length - 1].text.trim() === '') out.pop()
  if (out.length) {
    out[0].text = out[0].text.replace(/^\s+/, '')
    out[out.length - 1].text = out[out.length - 1].text.replace(/\s+$/, '')
  }
  return out
}

function imageOf(media: MediaImage | null | undefined, aspect: number, position?: string): PdfImage | null {
  if (!media?.src) return null
  return { src: media.src, alt: media.alt, position: position ?? media.position, aspect }
}

export function buildPdfModel(input: {
  lang: Lang
  content: PortfolioContent
  blocks: PortfolioBlocks
  media: PortfolioMedia
  url: string
}): PdfModel {
  const { lang, content, blocks, media, url } = input

  const field = (key: string): Rich => richFromDoc(blocks[key]?.[lang]?.json)

  /** A single-field block list (narrative lines, tags, skills…), page order, empties dropped. */
  const list = (prefix: string): Rich[] =>
    Object.entries(blocks)
      .filter(([key, byLang]) => key.startsWith(`${prefix}.`) && !key.slice(prefix.length + 1).includes('.') && byLang[lang])
      .map(([, byLang]) => byLang[lang]!)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((block) => richFromDoc(block.json))
      .filter((rich) => !isEmptyRich(rich))

  const stats = content.stats
    .map((_, i) => ({ value: field(`stats.${i}.value`), label: field(`stats.${i}.label`) }))
    .filter((stat) => !isEmptyRich(stat.value) || !isEmptyRich(stat.label))

  const chapters = content.journey.chapters
    .map((chapter) => ({
      tag: field(`journey.chapters.${chapter.id}.tag`),
      heading: field(`journey.chapters.${chapter.id}.heading`),
      body: field(`journey.chapters.${chapter.id}.body`),
      photo: imageOf(media.chapterPhotos[chapter.id], ASPECT.chapter),
    }))
    .filter((c) => !isEmptyRich(c.tag) || !isEmptyRich(c.heading) || !isEmptyRich(c.body))

  const projects = content.projects.items
    .map((project) => {
      const base = `projects.items.${project.id}`
      return {
        year: field(`${base}.year`),
        tag: field(`${base}.tag`),
        title: field(`${base}.title`),
        narrative: list(`${base}.narrative`),
        metrics: project.metrics
          .map((_, i) => ({ value: field(`${base}.metrics.${i}.value`), label: field(`${base}.metrics.${i}.label`) }))
          .filter((m) => !isEmptyRich(m.value) || !isEmptyRich(m.label)),
        tags: list(`${base}.tags`),
        // The card's first photo, the same one the page shows as its cover.
        cover: imageOf(media.projectImages[project.id]?.[0], ASPECT.project),
      }
    })
    .filter((p) => !isEmptyRich(p.title) || p.narrative.length > 0)

  const categories = content.skills.categories
    .map((category) => ({
      name: field(`skills.categories.${category.id}.category`),
      skills: list(`skills.categories.${category.id}.skills`),
    }))
    .filter((c) => !isEmptyRich(c.name) || c.skills.length > 0)

  // Certifications are a paired list: "<prefix>.<certId>.title|issuer",
  // one sort_order per certification (see usePairedBlockList).
  const certGroups = new Map<string, { sortOrder: number; title: Rich; issuer: Rich }>()
  for (const [key, byLang] of Object.entries(blocks)) {
    const match = /^skills\.certs\.([^.]+)\.(title|issuer)$/.exec(key)
    const block = byLang[lang]
    if (!match || !block) continue
    const group = certGroups.get(match[1]) ?? { sortOrder: block.sortOrder, title: [], issuer: [] }
    group.sortOrder = Math.min(group.sortOrder, block.sortOrder)
    group[match[2] as 'title' | 'issuer'] = richFromDoc(block.json)
    certGroups.set(match[1], group)
  }
  const certs = [...certGroups.values()]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .filter((c) => !isEmptyRich(c.title))
    .map(({ title, issuer }) => ({ title, issuer }))

  const name = field('hero.name')

  return {
    lang,
    plainName: plainText(name),
    url,
    hero: {
      greeting: field('hero.greeting'),
      name,
      tagline: field('hero.tagline'),
      description: field('hero.description'),
      // The square crop, when the owner set one: the PDF's portrait box is
      // square, which is exactly the shape `positionMobile` was chosen for.
      portrait: imageOf(media.portrait, ASPECT.portrait, media.portrait?.positionMobile ?? media.portrait?.position),
    },
    stats,
    journey: { title: field('journey.title'), chapters },
    projects: { title: field('projects.title'), subtitle: field('projects.subtitle'), items: projects },
    skills: { title: field('skills.title'), subtitle: field('skills.subtitle'), categories, certs },
    contact: {
      title: field('contact.title'),
      subtitle: field('contact.subtitle'),
      available: list('contact.availableItems'),
      email: content.contact.email.trim(),
      socials: content.contact.socials.filter((s) => s.label.trim() || s.url.trim()),
    },
    closing: field('footer.tagline'),
  }
}

/** "Conrado Figari Vechio" → "conrado-figari-vechio-portfolio-es.pdf". */
export function pdfFileName(model: PdfModel, fallback: string): string {
  const slug = (model.plainName || fallback)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${slug || 'portfolio'}-portfolio-${model.lang}.pdf`
}

/**
 * CSS `object-position` → fractions (0–1) of the slack on each axis, which is
 * exactly how the export's crop places its window: the same numbers mean the
 * same framing on the page and in the PDF. Accepts what this app stores —
 * "62% 35%", "center 40%", "left center", "center top" — and anything it
 * can't read falls back to centred rather than failing the export.
 */
export function parseObjectPosition(position: string | undefined): { x: number; y: number } {
  const words: Record<string, number> = { left: 0, top: 0, center: 0.5, right: 1, bottom: 1 }
  const tokens = (position ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)
  const value = (token: string | undefined): number | null => {
    if (!token) return null
    if (token in words) return words[token]
    const pct = /^(-?\d+(?:\.\d+)?)%$/.exec(token)
    return pct ? Math.min(1, Math.max(0, Number(pct[1]) / 100)) : null
  }
  let [first, second] = tokens
  // "top left" / "bottom center": a vertical keyword first means y comes first.
  if ((first === 'top' || first === 'bottom') && second !== 'top' && second !== 'bottom') {
    ;[first, second] = [second, first]
  }
  const x = value(first)
  const y = value(second)
  return { x: x ?? 0.5, y: y ?? 0.5 }
}
