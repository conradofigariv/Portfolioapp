import type { Lang, PortfolioBlocks, PortfolioMedia } from './portfolio'
import { starterContent } from './starter-content'
import { plainTextFromDoc } from './editor/render-html'

/**
 * Telling a new account's starter copy ("Your first project", "Where it
 * started", …) apart from what the owner wrote. Used by the CV import (starter
 * copy is replaced, the owner's own text is kept) and by the "how do you want
 * to start?" screen (shown only while the portfolio is still untouched).
 */

/** Every block's plain text, by key and language. */
export type BlockTexts = Record<string, Partial<Record<Lang, string>>>

const LANGS: Lang[] = ['en', 'es']

function normalize(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase()
}

// Every string a new account starts with, in both languages. Built with a
// marker for the name so the name-dependent ones ("© 2026 Ana") are left out:
// the owner's own name is never starter copy.
const MARK = '\u0001'
const STARTER = (() => {
  const set = new Set<string>()
  const walk = (value: unknown) => {
    if (typeof value === 'string') {
      if (!value.includes(MARK)) set.add(normalize(value))
    } else if (Array.isArray(value)) value.forEach(walk)
    else if (value && typeof value === 'object') Object.values(value).forEach(walk)
  }
  const s = starterContent(MARK)
  walk(s.en)
  walk(s.es)
  set.delete('')
  return set
})()

/** Empty, starter copy, or a bare year (the starter project's year is the year it was created). */
export function isPlaceholder(text: string | undefined): boolean {
  const t = normalize(text ?? '')
  return !t || STARTER.has(t) || /^\d{4}$/.test(t)
}

export function blockTextsFrom(blocks: PortfolioBlocks): BlockTexts {
  const out: BlockTexts = {}
  for (const [key, byLang] of Object.entries(blocks)) {
    for (const lang of LANGS) {
      const block = byLang[lang]
      if (block) (out[key] ??= {})[lang] = plainTextFromDoc(block.json)
    }
  }
  return out
}

// Fields a new account starts with that aren't starter copy: the name comes
// from Google, and the footer's "© 2026 <name>" is built from it.
const OWN_FROM_THE_START = new Set(['hero.name', 'footer.rights'])

/**
 * Nothing written yet: every text is starter copy (or empty), and no project
 * or chapter photo was uploaded. The portrait (the Google photo) and the CV
 * don't count — a new account can have both before writing a word.
 */
export function isUntouchedPortfolio(blocks: PortfolioBlocks, media: PortfolioMedia): boolean {
  const texts = blockTextsFrom(blocks)
  for (const [key, byLang] of Object.entries(texts)) {
    if (OWN_FROM_THE_START.has(key)) continue
    if (LANGS.some((lang) => !isPlaceholder(byLang[lang]))) return false
  }
  const photos = Object.values(media.projectImages).some((list) => list.length > 0)
  return !photos && Object.keys(media.chapterPhotos).length === 0
}
