import type { JSONContent } from '@tiptap/core'
import type { Lang } from '../portfolio'
import { extractTextNodes } from './tiptap-text'

/**
 * Step 2 of the AI translation feature: decide *what* to translate, before
 * anything is sent anywhere.
 *
 * `portfolio_blocks` is already one row per field per language, unique on
 * (portfolio_id, block_key, lang) — so "translate ES → EN" is just "for every
 * block_key that has an ES row, make sure the EN row exists and is current."
 * That makes this a pure function over rows, with no schema of its own: no
 * job table, no per-field "needs translation" flag, nothing to keep in sync.
 *
 * Staleness comes out of the same rows for free. Writing a translation makes
 * the target's updated_at newer than the source's, so the field reads as
 * current until the owner edits the source again — comparing the two
 * updated_at values *is* the signal. (One accepted false positive: writing EN
 * by hand first and ES afterwards marks the EN as stale. Harmless, because
 * updating a stale field is opt-in rather than automatic.)
 */

/**
 * One `portfolio_blocks` row, in the shape the planner needs.
 *
 * Deliberately *not* `PortfolioBlocks` (the map the page render uses): that
 * one drops `section`, which `upsertBlock` requires when it writes the target
 * row, and which cannot be re-derived from the block_key — `stats.<i>.value`
 * is stored under section "hero", so the prefix is not the section. `lang` is
 * a field here rather than a nesting level for the same reason: the caller
 * hands over a flat row list straight from the query, and the planner is the
 * thing that pairs source with target.
 */
export type TranslatableBlock = {
  blockKey: string
  section: string
  lang: Lang
  json: JSONContent | null
  updatedAt: string
  sortOrder: number
}

/**
 * A field the translator should work on. Carries everything needed to write
 * the target row later, so no second query sits between planning and saving:
 *
 * - `texts` is already extracted, so the batch translator never touches
 *   Tiptap JSON and the plan alone answers "how many strings is this?"
 * - `sourceJson` is the document those strings go back into (via
 *   `applyTextNodes`) — the target's own stored document is irrelevant, since
 *   a translation should inherit the *source's* current formatting.
 * - `sortOrder` is copied from the source row because `upsertBlock` does not
 *   write that column: without carrying it, a translated list item (a
 *   narrative line, a tag, a certification) would land on the default value
 *   and scramble the target language's list order.
 */
export type PlannedField = {
  blockKey: string
  section: string
  sourceJson: JSONContent
  texts: string[]
  sortOrder: number
}

export type TranslationPlan = {
  /** Target row missing or empty — translated by default. */
  missing: PlannedField[]
  /** Target row exists, but the source has been edited since — opt-in. */
  stale: PlannedField[]
  /** Target exists and is at least as new as the source. */
  unchanged: number
  /** Source row exists but has no text at all — nothing to translate. */
  emptySource: number
  /**
   * How many of the planned fields above carry no letters at all ("50+",
   * "2013 — 2020"). They are planned like any other field, because the target
   * language still needs its own row — otherwise the English page shows a blank
   * where the Spanish one shows "50+". They just cost no model call:
   * `translateBatch` resolves a field with nothing translatable in it by copying
   * the source document verbatim. Reported separately so the progress UI can
   * say "N copied as-is" rather than implying they were translated.
   */
  languageNeutral: number
}

/** The whole field's text, as one string, for the emptiness checks below. */
function joinedText(texts: string[]): string {
  return texts.join('')
}

/**
 * Whether a field needs a model call at all. A field whose entire text has no
 * letter in it — a number, a year range, a "+", a "%" — reads identically in
 * both languages, so sending it costs tokens and risks the model "helpfully"
 * rewriting a figure. `\p{L}` rather than a-z so accented and non-Latin text
 * counts; "8 years" still has letters and is still translated.
 *
 * Note this only decides *how* the field gets filled, not *whether*: it is
 * still planned, and still gets a target row (see `languageNeutral`).
 */
function hasTranslatableText(texts: string[]): boolean {
  return /\p{L}/u.test(joinedText(texts))
}

function isEmpty(texts: string[]): boolean {
  return joinedText(texts).trim() === ''
}

/**
 * Whether `a` is strictly newer than `b`. Parsed rather than compared as
 * strings: `updated_at` is a timestamptz, and while supabase-js happens to
 * hand back a consistently-formatted ISO string today, a lexicographic
 * comparison silently gives the wrong answer the moment two rows come back
 * with different offsets ("+00:00" vs "Z", or a non-UTC offset). An
 * unparseable value falls back to the string comparison rather than reading as
 * "not newer", so a malformed timestamp can't hide a genuinely stale field.
 */
function isNewer(a: string, b: string): boolean {
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a > b
  return ta > tb
}

/**
 * Classify every field of `rows` for a `from` → `to` translation.
 *
 * Both lists come back sorted by `blockKey`, which is what makes chunking
 * work without an offset or a cursor: a chunk is "take the next N from a
 * freshly recomputed plan". Because a field that was just translated stops
 * being `missing`/`stale` (its target row now exists and is newer than the
 * source), each chunk naturally starts where the previous one stopped —
 * resumable after a timeout or a closed tab, and self-correcting if a field
 * failed partway through, with no state stored anywhere.
 *
 * Rows in a language other than `from`/`to` are ignored, as are block_keys
 * that exist only in the target language (nothing to translate them from).
 */
export function planTranslation(
  rows: TranslatableBlock[],
  from: Lang,
  to: Lang
): TranslationPlan {
  const sources = new Map<string, TranslatableBlock>()
  const targets = new Map<string, TranslatableBlock>()
  for (const row of rows) {
    if (row.lang === from) sources.set(row.blockKey, row)
    else if (row.lang === to) targets.set(row.blockKey, row)
  }

  const plan: TranslationPlan = {
    missing: [],
    stale: [],
    unchanged: 0,
    emptySource: 0,
    languageNeutral: 0,
  }

  for (const blockKey of [...sources.keys()].sort()) {
    const source = sources.get(blockKey)!
    const texts = extractTextNodes(source.json)

    if (isEmpty(texts)) {
      plan.emptySource++
      continue
    }

    const field: PlannedField = {
      blockKey,
      section: source.section,
      // Non-null: extractTextNodes returned text, so there is a document.
      sourceJson: source.json!,
      texts,
      sortOrder: source.sortOrder,
    }

    const target = targets.get(blockKey)
    // An existing-but-empty target counts as missing, not as up to date — an
    // empty row is what the block-list "add item" action inserts, so a list
    // item added in the target language and never filled in should still get
    // its translation rather than being read as deliberate content.
    if (!target || isEmpty(extractTextNodes(target.json))) {
      plan.missing.push(field)
    } else if (isNewer(source.updatedAt, target.updatedAt)) {
      plan.stale.push(field)
    } else {
      plan.unchanged++
      continue
    }

    if (!hasTranslatableText(texts)) plan.languageNeutral++
  }

  return plan
}

/** How many fields the plan would fill, for progress UI and chunking. */
export function plannedCount(plan: TranslationPlan, includeStale: boolean): number {
  return plan.missing.length + (includeStale ? plan.stale.length : 0)
}

/**
 * The fields a run should work through, in order: everything missing first,
 * then the stale ones if the owner opted into those. Filling the gaps is the
 * default action and the one the owner asked for, so it should never be stuck
 * behind re-translating fields that already have content.
 */
export function plannedFields(plan: TranslationPlan, includeStale: boolean): PlannedField[] {
  return includeStale ? [...plan.missing, ...plan.stale] : plan.missing
}
