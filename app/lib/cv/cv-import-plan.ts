import type { JSONContent } from '@tiptap/core'
import type { CvExtract } from './cv-schema'
import type { HideableSection, Lang, PortfolioContent, PortfolioMedia, Project } from '../portfolio'
import { hiddenSectionsOf } from '../portfolio'
import { renderBlockHtml } from '../editor/render-html'
import { blockTextsFrom, isPlaceholder, type BlockTexts } from '../starter-detect'

export { blockTextsFrom, type BlockTexts }

/**
 * What importing a CV does to a portfolio, decided in one pure function so
 * every rule is checked offline and the import panel can show the same numbers
 * the server will act on (it runs this on the page's own data for the
 * preview; `importCv` runs it again on the database's).
 *
 * The rules (see CLAUDE.md, "Onboarding with a CV", step 10):
 *
 * - **Text is written in the CV's language only.** The other language is left
 *   for the translator to fill: a field it has only starter copy for is
 *   emptied (so translation sees it as missing), one the owner wrote is kept
 *   (translation then offers it for review as out of date). The name is the
 *   one exception — it reads the same in both, so it's written to both.
 * - **A section the CV has something for is replaced whole**: every job
 *   becomes a project (and the section is retitled Experience), education
 *   becomes the Story's chapters (retitled Education), skill groups and
 *   spoken languages become skill categories, certifications replace the
 *   certifications. What's removed takes its photos with it; the panel says
 *   how many of those were the owner's own before they confirm.
 * - **A section the CV has nothing for keeps what the owner wrote** and only
 *   loses starter copy ("Your first project", "Where it started").
 * - **Leftover placeholders go** — the starter tagline, description, the "0"
 *   stats, "Your closing line" — wherever the CV didn't replace them, so the
 *   page doesn't mix a real CV with instructions. Starter copy that reads as a
 *   real default (greeting, section titles, "Let's talk") stays.
 * - A section left with nothing in it is hidden (the owner sees the "hidden"
 *   bar and can show it again); one that received something is shown.
 * - Contact: LinkedIn and website are added as links if not already there;
 *   the email only when the owner ticked it.
 */

export type BlockRow = {
  section: string
  block_key: string
  lang: Lang
  sort_order: number
  content_json: JSONContent
  content_html: string
}


export type CvImportSummary = {
  lang: Lang
  added: { jobs: number; education: number; skillGroups: number; certifications: number; links: number; email: boolean }
  /** Entities the owner wrote themselves (not starter copy) that the import removes. */
  replaced: { projects: number; chapters: number; skillGroups: number; certifications: number; photos: number }
  hidden: HideableSection[]
}

export type CvImportPlan = {
  content: Record<Lang, PortfolioContent>
  /** Rows to write (upsert on portfolio_id, block_key, lang). */
  upserts: BlockRow[]
  /** Single rows to delete. */
  deletes: { blockKey: string; lang: Lang }[]
  /** Whole entities to delete, blocks and files: projects/chapters/certs in both languages, categories per language. */
  removed: { projects: string[]; chapters: string[]; categories: { id: string; lang: Lang }[]; certs: string[] }
  summary: CvImportSummary
}

export type CvImportInput = {
  cv: CvExtract
  content: Record<Lang, PortfolioContent>
  texts: BlockTexts
  media?: Pick<PortfolioMedia, 'projectImages' | 'chapterPhotos' | 'certFiles'>
  includeEmail: boolean
  /** Makes new entity ids unique to this import (`project-<stamp>-0`). */
  stamp: string
}

const LANGS: Lang[] = ['en', 'es']
const other = (lang: Lang): Lang => (lang === 'es' ? 'en' : 'es')

const SECTION_TITLES = {
  projects: { es: 'Experiencia', en: 'Experience' },
  journey: { es: 'Formación', en: 'Education' },
  languages: { es: 'Idiomas', en: 'Languages' },
} as const

// ---------------------------------------------------------------- starter copy

/** Every stored key under a prefix. */
function keysUnder(texts: BlockTexts, prefix: string): string[] {
  return Object.keys(texts).filter((key) => key.startsWith(prefix))
}

/** An entity is the owner's own if any of its fields, in either language, is more than starter copy. */
function isOwn(texts: BlockTexts, prefix: string): boolean {
  return keysUnder(texts, prefix).some((key) => LANGS.some((lang) => !isPlaceholder(texts[key][lang])))
}

// ---------------------------------------------------------------- the plan

function doc(text: string): JSONContent {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }
}

function linkKey(url: string): string {
  return url.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '')
}

function certIdsIn(texts: BlockTexts): string[] {
  const ids = new Set<string>()
  for (const key of Object.keys(texts)) {
    const m = /^skills\.certs\.([^.]+)\.(title|issuer)$/.exec(key)
    if (m) ids.add(m[1])
  }
  return [...ids].sort()
}

export function planCvImport({ cv, content, texts, media, includeEmail, stamp }: CvImportInput): CvImportPlan {
  const L = cv.language
  const O = other(L)
  const upserts: BlockRow[] = []
  const deletes: { blockKey: string; lang: Lang }[] = []
  const written = new Set<string>() // `${lang}:${key}`

  const write = (section: string, blockKey: string, lang: Lang, text: string, sortOrder = 0) => {
    const value = text.trim()
    if (!value) return
    const json = doc(value)
    upserts.push({ section, block_key: blockKey, lang, sort_order: sortOrder, content_json: json, content_html: renderBlockHtml(json) })
    written.add(`${lang}:${blockKey}`)
  }
  // A field written in the CV's language: the other language's copy is
  // emptied only when it's starter copy (see the rules above).
  const writeScalar = (section: string, blockKey: string, text: string) => {
    if (!text.trim()) return
    write(section, blockKey, L, text)
    if (texts[blockKey]?.[O] !== undefined && isPlaceholder(texts[blockKey][O])) deletes.push({ blockKey, lang: O })
  }
  const deleteIfPlaceholder = (blockKey: string, lang: Lang) => {
    if (written.has(`${lang}:${blockKey}`)) return
    const text = texts[blockKey]?.[lang]
    if (text !== undefined && isPlaceholder(text)) deletes.push({ blockKey, lang })
  }

  const has = {
    jobs: cv.experience.length > 0,
    education: cv.education.length > 0,
    skills: cv.skills.length > 0 || cv.languages.length > 0,
    certs: cv.certifications.length > 0,
  }

  // ---- hero
  if (cv.name) {
    write('hero', 'hero.name', L, cv.name)
    write('hero', 'hero.name', O, cv.name)
  }
  writeScalar('hero', 'hero.tagline', cv.headline)
  writeScalar('hero', 'hero.description', cv.summary)

  // ---- projects ← experience
  const L_items = content[L].projects.items
  const removedProjects = has.jobs
    ? L_items.map((p) => p.id)
    : L_items.filter((p) => !isOwn(texts, `projects.items.${p.id}.`)).map((p) => p.id)
  const keptProjects = L_items.filter((p) => !removedProjects.includes(p.id)).map((p) => p.id)
  const newProjects: Project[] = cv.experience.map((job, i) => {
    const id = `project-${stamp}-${i}`
    const base = `projects.items.${id}`
    const title = job.role || job.company
    const tag = job.role ? job.company : ''
    write('projects', `${base}.title`, L, title)
    write('projects', `${base}.tag`, L, tag)
    write('projects', `${base}.year`, L, job.period)
    job.highlights.forEach((line, j) => write('projects', `${base}.narrative.cv-${j}`, L, line, j))
    job.tools.forEach((tool, j) => write('projects', `${base}.tags.cv-${j}`, L, tool, j))
    job.metrics.forEach((metric, j) => {
      write('projects', `${base}.metrics.${j}.label`, L, metric.label)
      write('projects', `${base}.metrics.${j}.value`, L, metric.value)
    })
    return { id, year: job.period, tag, title, narrative: [...job.highlights], metrics: [0, 1, 2].map((j) => ({ ...(job.metrics[j] ?? { label: '', value: '' }) })), tags: [...job.tools] }
  })
  if (has.jobs) {
    write('projects', 'projects.title', L, SECTION_TITLES.projects[L])
    write('projects', 'projects.title', O, SECTION_TITLES.projects[O])
  }

  // ---- story ← education
  const L_chapters = content[L].journey.chapters
  const removedChapters = has.education
    ? L_chapters.map((c) => c.id)
    : L_chapters.filter((c) => !isOwn(texts, `journey.chapters.${c.id}.`)).map((c) => c.id)
  const newChapters = cv.education.map((edu, i) => {
    const id = `chapter-${stamp}-${i}`
    const base = `journey.chapters.${id}`
    const heading = edu.degree || edu.institution
    const body = edu.degree ? edu.institution : ''
    write('journey', `${base}.tag`, L, edu.period)
    write('journey', `${base}.heading`, L, heading)
    write('journey', `${base}.body`, L, body)
    return { id, tag: edu.period, heading, body }
  })
  if (has.education) {
    write('journey', 'journey.title', L, SECTION_TITLES.journey[L])
    write('journey', 'journey.title', O, SECTION_TITLES.journey[O])
  }

  // ---- skills ← skill groups + spoken languages (categories live per language)
  const groups = [
    ...cv.skills.map((g) => ({ category: g.category, items: g.items })),
    ...(cv.languages.length ? [{ category: SECTION_TITLES.languages[L], items: cv.languages }] : []),
  ].slice(0, 12)
  const newCategories = groups.map((group, i) => {
    const id = `skillcat-${stamp}-${i}`
    const base = `skills.categories.${id}`
    write('skills', `${base}.category`, L, group.category)
    group.items.forEach((item, j) => write('skills', `${base}.skills.cv-${j}`, L, item, j))
    return { id, category: group.category, skills: [...group.items] }
  })
  const removedCategories: { id: string; lang: Lang }[] = []
  const keptCategories: Record<Lang, PortfolioContent['skills']['categories']> = { en: [], es: [] }
  for (const lang of LANGS) {
    for (const cat of content[lang].skills.categories) {
      // Own in *either* language: an imported category has text only in the
      // CV's language until it's translated, and dropping its (still empty)
      // copy in the other language would leave the translation nowhere to go.
      const own = isOwn(texts, `skills.categories.${cat.id}.`)
      if (has.skills || !own) removedCategories.push({ id: cat.id, lang })
      else keptCategories[lang].push(cat)
    }
  }

  // ---- certifications (blocks only; ids shared across languages)
  const existingCerts = certIdsIn(texts)
  const removedCerts = has.certs ? existingCerts : existingCerts.filter((id) => !isOwn(texts, `skills.certs.${id}.`))
  cv.certifications.forEach((cert, i) => {
    const base = `skills.certs.cert-${stamp}-${i}`
    write('skills', `${base}.title`, L, cert.title, i)
    write('skills', `${base}.issuer`, L, [cert.issuer, cert.year].filter(Boolean).join(' · '), i)
  })

  // ---- leftover placeholders
  for (const lang of LANGS) {
    for (const key of ['hero.tagline', 'hero.description', 'projects.subtitle', 'projects.ctaDescription', 'footer.tagline']) {
      deleteIfPlaceholder(key, lang)
    }
    for (let i = 0; i < 3; i++) {
      // A stat goes only as a pair: "0" is a real value next to a real label.
      const value = texts[`stats.${i}.value`]?.[lang]
      const label = texts[`stats.${i}.label`]?.[lang]
      if (isPlaceholder(value) && isPlaceholder(label)) {
        deleteIfPlaceholder(`stats.${i}.value`, lang)
        deleteIfPlaceholder(`stats.${i}.label`, lang)
      }
    }
    for (const key of keysUnder(texts, 'contact.availableItems.')) deleteIfPlaceholder(key, lang)
  }

  // ---- contact
  const links = [
    cv.contact.linkedin && { url: cv.contact.linkedin },
    cv.contact.website && { url: cv.contact.website },
  ]
    .filter((l): l is { url: string } => !!l)
    .map(({ url }) => {
      const full = /^https?:\/\//i.test(url) ? url : `https://${url}`
      return { label: linkKey(full), url: full }
    })
  const email = includeEmail ? cv.contact.email : ''

  // ---- the new content, both languages
  const hiddenBefore = hiddenSectionsOf(content[L])
  const nextContent = {} as Record<Lang, PortfolioContent>
  let linksAdded = 0
  for (const lang of LANGS) {
    const c = content[lang]
    const blank = (p: Project): Project => ({ ...p, year: '', tag: '', title: '', narrative: [], metrics: p.metrics.map(() => ({ label: '', value: '' })), tags: [] })
    const projects = [
      ...c.projects.items.filter((p) => keptProjects.includes(p.id)),
      ...newProjects.map((p) => (lang === L ? p : blank(p))),
    ]
    const chapters = [
      ...c.journey.chapters.filter((ch) => !removedChapters.includes(ch.id)),
      ...newChapters.map((ch) => (lang === L ? ch : { ...ch, tag: '', heading: '', body: '' })),
    ]
    const categories = [
      ...keptCategories[lang],
      ...newCategories.map((cat) => (lang === L ? cat : { ...cat, category: '', skills: [] })),
    ]
    const socials = [...c.contact.socials]
    for (const link of links) {
      if (socials.length >= 6 || socials.some((s) => linkKey(s.url) === linkKey(link.url))) continue
      socials.push(link)
      if (lang === L) linksAdded++
    }
    nextContent[lang] = {
      ...c,
      journey: { ...c.journey, chapters },
      projects: { ...c.projects, items: projects },
      skills: { ...c.skills, categories },
      contact: { ...c.contact, socials, email: email || c.contact.email },
    }
  }

  // ---- sections: shown when they received something, hidden when left empty
  const remainingCerts = existingCerts.length - removedCerts.length + cv.certifications.length
  const filled: Record<HideableSection, boolean | null> = {
    projects: has.jobs ? true : nextContent[L].projects.items.length === 0 ? false : null,
    journey: has.education ? true : nextContent[L].journey.chapters.length === 0 ? false : null,
    skills: has.skills || has.certs ? true : nextContent[L].skills.categories.length === 0 && remainingCerts === 0 ? false : null,
    contact: null,
  }
  const hidden = new Set(hiddenBefore)
  for (const [section, state] of Object.entries(filled) as [HideableSection, boolean | null][]) {
    if (state === true) hidden.delete(section)
    if (state === false) hidden.add(section)
  }
  const hiddenSections = [...hidden]
  for (const lang of LANGS) nextContent[lang] = { ...nextContent[lang], hiddenSections }

  // ---- what the owner loses, for the confirmation
  const ownProjects = removedProjects.filter((id) => isOwn(texts, `projects.items.${id}.`))
  const ownChapters = removedChapters.filter((id) => isOwn(texts, `journey.chapters.${id}.`))
  const ownCerts = removedCerts.filter((id) => isOwn(texts, `skills.certs.${id}.`))
  const ownCategories = new Set(
    removedCategories.filter(({ id }) => isOwn(texts, `skills.categories.${id}.`)).map(({ id }) => id)
  )
  const photos =
    removedProjects.reduce((n, id) => n + (media?.projectImages[id]?.length ?? 0), 0) +
    removedChapters.filter((id) => media?.chapterPhotos[id]).length +
    removedCerts.filter((id) => media?.certFiles[id]).length

  return {
    content: nextContent,
    upserts,
    deletes,
    removed: { projects: removedProjects, chapters: removedChapters, categories: removedCategories, certs: removedCerts },
    summary: {
      lang: L,
      added: {
        jobs: cv.experience.length,
        education: cv.education.length,
        skillGroups: groups.length,
        certifications: cv.certifications.length,
        links: linksAdded,
        email: !!email,
      },
      replaced: {
        projects: ownProjects.length,
        chapters: ownChapters.length,
        skillGroups: ownCategories.size,
        certifications: ownCerts.length,
        photos,
      },
      hidden: hiddenSections.filter((s) => !hiddenBefore.includes(s)),
    },
  }
}
