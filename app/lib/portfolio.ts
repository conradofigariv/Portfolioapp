import type { JSONContent } from '@tiptap/core'
import { translations, Lang } from './translations'

export type { Lang }

export type MediaImage = {
  src: string
  alt: string
  // Project cards take a Tailwind class; journey photos take a raw CSS object-position.
  position?: string
  positionMobile?: string
}

export type Metric = { label: string; value: string }

export type Project = {
  id: string
  year: string
  tag: string
  title: string
  narrative: string[]
  metrics: Metric[]
  tags: string[]
}

export type JourneyChapter = {
  id: string
  tag: string
  heading: string
  body: string
}

export type SkillCategory = { id: string; category: string; skills: string[] }
export type Certification = { title: string; issuer: string }

// Everything a person writes about themselves. Interface labels (buttons, form
// fields, nav) stay in translations.ts because they are identical for every user.
export type PortfolioContent = {
  hero: { greeting: string; name: string; tagline: string; description: string }
  stats: Metric[]
  journey: { title: string; chapters: JourneyChapter[] }
  projects: {
    title: string
    subtitle: string
    ctaTitle: string
    ctaDescription: string
    items: Project[]
  }
  skills: {
    title: string
    subtitle: string
    categories: SkillCategory[]
    certs: Certification[]
  }
  contact: {
    title: string
    subtitle: string
    availableItems: string[]
    email: string
    socials: { label: string; url: string }[]
  }
  footer: { tagline: string; rights: string }
}

// Files are language-independent, so they are keyed by the stable id of the project
// or chapter they belong to rather than duplicated into each language tree.
export type PortfolioMedia = {
  portrait: MediaImage | null
  backgroundVideos: string[]
  cv: string | null
  projectImages: Record<string, MediaImage[]>
  chapterPhotos: Record<string, MediaImage>
  // One optional file per certification (the certificate itself, a PDF or a
  // photo of it), keyed by that certification's block-list item id. Unlike
  // every other entry here it can be a PDF, so a reader has to branch on the
  // source's extension rather than assume an image — see CertificationCard.
  certFiles: Record<string, MediaImage>
}

// A rich text field migrated to portfolio_blocks (Tiptap), replacing its
// plain-string equivalent in PortfolioContent. Keyed by the same dot-path
// block_key content-path.ts already resolves (e.g. "hero.name"), so a
// migrated field's call site only swaps which component reads/writes it.
//
// sortOrder only matters for a block that's one item in an owner-editable
// list (e.g. "projects.items.<id>.narrative.<lineId>") — every sibling
// sharing that list's key prefix sorts by it. A scalar field like
// "hero.name" has no siblings, so its sortOrder is meaningless and ignored.
export type PortfolioBlock = { json: JSONContent; html: string; updatedAt: string; sortOrder: number }
export type PortfolioBlocks = Record<string, Partial<Record<Lang, PortfolioBlock>>>

export type Portfolio = {
  username: string
  media: PortfolioMedia
  content: Record<Lang, PortfolioContent>
  blocks: PortfolioBlocks
}

export const projectId = (index: number) => `project-${index}`
export const chapterId = (index: number) => `chapter-${index}`
export const skillCategoryId = (index: number) => `skillcat-${index}`

function toContent(t: (typeof translations)['en']): PortfolioContent {
  return {
    hero: {
      greeting: t.hero.greeting,
      name: t.hero.name,
      tagline: t.hero.tagline,
      description: t.hero.description,
    },
    stats: Object.values(t.hero.stats),
    journey: {
      title: t.journey.title,
      chapters: t.journey.chapters.map((c, i) => ({ id: chapterId(i), ...c })),
    },
    projects: {
      title: t.projects.title,
      subtitle: t.projects.subtitle,
      ctaTitle: t.projects.cta.title,
      ctaDescription: t.projects.cta.description,
      items: t.projects.items.map((p, i) => ({
        id: projectId(i),
        ...p,
        narrative: [...p.narrative],
        metrics: p.metrics.map((m) => ({ ...m })),
        tags: [...p.tags],
      })),
    },
    skills: {
      title: t.skills.title,
      subtitle: t.skills.subtitle,
      categories: t.skills.categories.map((c, i) => ({
        id: skillCategoryId(i),
        category: c.category,
        skills: [...c.skills],
      })),
      certs: t.skills.certs.map((c) => ({ ...c })),
    },
    contact: {
      title: t.contact.title,
      subtitle: t.contact.subtitle,
      availableItems: [...t.contact.availableItems],
      // Not modeled in translations.ts because it is Conrado's own contact
      // info, not interface copy — every other account starts with none of it.
      email: 'conradofigari.v@gmail.com',
      socials: [
        { label: 'linkedin.com/in/conradofigarivechio', url: 'https://www.linkedin.com/in/conradofigarivechio/' },
        { label: 'github.com/conradofigariv', url: 'https://github.com/conradofigariv' },
      ],
    },
    footer: {
      tagline: t.footer.tagline,
      rights: t.footer.rights,
    },
  }
}

const CONRADO_MEDIA: PortfolioMedia = {
  portrait: { src: '/conrado.jpg', alt: 'Conrado Figari' },
  backgroundVideos: ['/videos/video-1.mp4', '/videos/video-2.mp4'],
  cv: '/PO_ConradoFigariVechio_ENG.pdf',
  projectImages: {
    [projectId(0)]: [
      { src: '/epec-saas-dashboard.png', alt: 'One of the SaaS tools built at EPEC' },
      { src: '/EPEC.jpg', alt: 'EPEC building' },
    ],
    [projectId(1)]: [
      { src: '/cramer-trading.png', alt: 'CramerBot AI trading platform' },
      { src: '/cramerbot-office.jpeg', alt: 'CramerBot team working session' },
    ],
    [projectId(2)]: [
      { src: '/trackr-app.jpeg', alt: 'Trackr personal finance app', position: 'center 40%' },
    ],
    [projectId(4)]: [{ src: '/crm-n8n-workflow.png', alt: 'N8n workflow powering the AI CRM' }],
    [projectId(5)]: [
      { src: '/tiktok-plugstore.png', alt: 'Plug Store TikTok account with 4,000+ followers' },
    ],
    [projectId(6)]: [
      { src: '/plug-inventory.jpg', alt: 'Plug business inventory', position: 'center 65%' },
    ],
    [projectId(7)]: [
      { src: '/aveit-team.png', alt: 'AVEIT team' },
      { src: '/aveit-hr-team.jpeg', alt: 'AVEIT HR team' },
      { src: '/aveit-raffle.png', alt: 'AVEIT raffle tickets' },
    ],
  },
  chapterPhotos: {
    [chapterId(0)]: { src: '/aveit-raffle.png', alt: 'AVEIT raffle tickets', position: 'center center' },
    [chapterId(1)]: { src: '/aveit-hr-team.jpeg', alt: 'AVEIT HR team', position: 'center center' },
    [chapterId(2)]: {
      src: '/tiktok-plugstore.png',
      alt: 'Plug Store TikTok account with 4,500 followers',
      position: 'left center',
      positionMobile: 'center top',
    },
    [chapterId(3)]: {
      src: '/reading-book-park.jpeg',
      alt: 'Conrado reading in the park',
      position: 'center center',
      positionMobile: 'center 90%',
    },
    [chapterId(4)]: { src: '/EPEC.jpg', alt: 'EPEC building', position: 'right center' },
  },
  // Seeded empty: a certificate file is something an owner uploads, not
  // something the starting template can ship a stand-in for.
  certFiles: {},
}

// Conrado's portfolio, and the template new accounts start from.
export const defaultPortfolio: Portfolio = {
  username: 'conrado',
  media: CONRADO_MEDIA,
  content: {
    en: toContent(translations.en),
    es: toContent(translations.es),
  },
  blocks: {},
}
