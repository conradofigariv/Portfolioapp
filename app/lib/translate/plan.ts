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

/**
 * The block-list fields: every item of a list shares one key prefix and gets a
 * **random item id per language** (block-list-actions.ts), so the same list in
 * EN and ES is two unrelated sets of keys unless one was translated from the
 * other (which deliberately reuses the source's ids — see CLAUDE.md).
 *
 * That is why a list can't be planned item by item like a scalar field:
 * surfaced live, translating EN → ES added every English line/tag *next to*
 * the Spanish ones the owner had already written by hand ("Supabase Supabase",
 * each project line twice), because none of the English item ids existed in
 * Spanish, so each one read as "missing". Lists are compared as a whole
 * instead — see `planTranslation`.
 *
 * `field` is only set for multi-field items (a certification's title/issuer),
 * whose keys carry one more segment after the item id.
 */
export type ListKind = 'narrative' | 'tags' | 'skills' | 'availability' | 'certs'

const LIST_PATTERNS: { re: RegExp; kind: ListKind; fields?: string[] }[] = [
  { re: /^(projects\.items\.[^.]+\.narrative)\.([^.]+)$/, kind: 'narrative' },
  { re: /^(projects\.items\.[^.]+\.tags)\.([^.]+)$/, kind: 'tags' },
  { re: /^(skills\.categories\.[^.]+\.skills)\.([^.]+)$/, kind: 'skills' },
  { re: /^(contact\.availableItems)\.([^.]+)$/, kind: 'availability' },
  { re: /^(skills\.certs)\.([^.]+)\.(title|issuer)$/, kind: 'certs', fields: ['title', 'issuer'] },
]

export function listItemOf(
  blockKey: string
): { prefix: string; itemId: string; kind: ListKind; field: string | null; fieldIndex: number } | null {
  for (const { re, kind, fields } of LIST_PATTERNS) {
    const m = re.exec(blockKey)
    if (m) {
      const field = m[3] ?? null
      return { prefix: m[1], itemId: m[2], kind, field, fieldIndex: field && fields ? fields.indexOf(field) : 0 }
    }
  }
  return null
}

export type ListChoice = 'sync' | 'replace' | 'dedupe'

/** One item of a list as the review shows it: plain text, in list order. */
export type ListItemView = { itemId: string; text: string; sortOrder: number }

/**
 * A list whose target language already has content and doesn't match the
 * source — so nothing in it is written without the owner choosing how.
 *
 * - `source[].status`: `shared` (the target has an item with this id — it was
 *   translated from this one before), `changed` (shared, but the source was
 *   edited since), `new` (the target has no item with this id).
 * - `target[].shared`: whether that target item came from a source item (same
 *   id). A target item that *isn't* shared was written in the target language
 *   by hand — the case that must never be overwritten silently.
 * - `choices` — which actions make sense, besides leaving it alone:
 *   - `sync`: add the `new` items and update the `changed` ones, delete
 *     nothing. Only when every target item is shared (the lists are aligned).
 *   - `replace`: the target list becomes the translation of the source list.
 *   - `dedupe`: delete the shared items, keep the hand-written ones. Only when
 *     the target has both — exactly the state the first version of this
 *     feature left behind, so this is also how that gets cleaned up.
 */
export type ListReview = {
  prefix: string
  section: string
  kind: ListKind
  /** The owning project's title / skill category's name, when there is one. */
  parentTitle: string
  source: (ListItemView & { keys: string[]; status: 'shared' | 'changed' | 'new' })[]
  target: (ListItemView & { shared: boolean })[]
  /** Every target row under the prefix, empty ones included — what `replace` deletes. */
  targetKeys: string[]
  /** Every non-empty field of every source item — what gets translated. */
  fields: PlannedField[]
  choices: ListChoice[]
}

export type TranslationPlan = {
  /**
   * Written straight away, no review: a field with no (or an empty) target
   * row, and every item of a list whose target has no content at all. Nothing
   * the owner wrote can be overwritten by these.
   */
  missing: PlannedField[]
  /**
   * A scalar field whose target exists but whose source was edited since — goes
   * to review with the current target text alongside.
   */
  stale: (PlannedField & { current: string })[]
  /** Lists whose target already has content that differs — goes to review. */
  lists: ListReview[]
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
   * the source document verbatim.
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

function plainText(json: JSONContent | null): string {
  return joinedText(extractTextNodes(json)).replace(/\s+/g, ' ').trim()
}

/**
 * Classify every field of `rows` for a `from` → `to` translation.
 *
 * `missing` comes back sorted by `blockKey`, which is what makes chunking
 * work without an offset or a cursor: a chunk is "take the next N from a
 * freshly recomputed plan". Because a field that was just translated stops
 * being `missing` (its target row now exists and is newer than the source),
 * each chunk naturally starts where the previous one stopped — resumable after
 * a timeout or a closed tab, with no state stored anywhere.
 *
 * Lists are planned as a unit (see `ListReview`): a list whose target has no
 * content is filled like any missing field, reusing the source's item ids; one
 * whose target *has* content is either already in step (every item shared, none
 * stale, none new) or goes to review. Never item-by-item into a list that has
 * content — that is what duplicated the owner's hand-written lines.
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
    lists: [],
    unchanged: 0,
    emptySource: 0,
    languageNeutral: 0,
  }

  const toField = (source: TranslatableBlock, texts: string[]): PlannedField => ({
    blockKey: source.blockKey,
    section: source.section,
    // Non-null: only called once extractTextNodes returned text.
    sourceJson: source.json!,
    texts,
    sortOrder: source.sortOrder,
  })
  const countNeutral = (texts: string[]) => {
    if (!hasTranslatableText(texts)) plan.languageNeutral++
  }

  // Scalars first; list rows are only grouped here and planned below.
  type Grouped = { source: TranslatableBlock[]; target: TranslatableBlock[] }
  const lists = new Map<string, Grouped>()
  const group = (row: TranslatableBlock, side: keyof Grouped) => {
    const item = listItemOf(row.blockKey)
    if (!item) return false
    const entry = lists.get(item.prefix) ?? { source: [], target: [] }
    entry[side].push(row)
    lists.set(item.prefix, entry)
    return true
  }
  for (const row of targets.values()) group(row, 'target')

  for (const blockKey of [...sources.keys()].sort()) {
    const source = sources.get(blockKey)!
    if (group(source, 'source')) continue

    const texts = extractTextNodes(source.json)
    if (isEmpty(texts)) {
      plan.emptySource++
      continue
    }

    const target = targets.get(blockKey)
    // An existing-but-empty target counts as missing, not as up to date.
    if (!target || isEmpty(extractTextNodes(target.json))) {
      plan.missing.push(toField(source, texts))
    } else if (isNewer(source.updatedAt, target.updatedAt)) {
      plan.stale.push({ ...toField(source, texts), current: plainText(target.json) })
    } else {
      plan.unchanged++
      continue
    }
    countNeutral(texts)
  }

  for (const prefix of [...lists.keys()].sort()) {
    const { source: sourceRows, target: targetRows } = lists.get(prefix)!
    const review = planList(prefix, sourceRows, targetRows, sources, plan)
    if (review) plan.lists.push(review)
  }

  plan.missing.sort((a, b) => (a.blockKey < b.blockKey ? -1 : a.blockKey > b.blockKey ? 1 : 0))
  return plan

  function planList(
    prefix: string,
    sourceRows: TranslatableBlock[],
    targetRows: TranslatableBlock[],
    allSources: Map<string, TranslatableBlock>,
    out: TranslationPlan
  ): ListReview | null {
    type Item = { itemId: string; rows: TranslatableBlock[]; sortOrder: number }
    const byItem = (rows: TranslatableBlock[]) => {
      const items = new Map<string, Item>()
      for (const row of rows) {
        const { itemId } = listItemOf(row.blockKey)!
        const item = items.get(itemId) ?? { itemId, rows: [], sortOrder: row.sortOrder }
        item.rows.push(row)
        item.sortOrder = Math.min(item.sortOrder, row.sortOrder)
        items.set(itemId, item)
      }
      for (const item of items.values()) {
        item.rows.sort((a, b) => listItemOf(a.blockKey)!.fieldIndex - listItemOf(b.blockKey)!.fieldIndex)
      }
      return items
    }
    const itemText = (item: Item) =>
      item.rows
        .map((row) => plainText(row.json))
        .filter(Boolean)
        .join(' — ')
    const bySort = <T extends { sortOrder: number; itemId: string }>(a: T, b: T) =>
      a.sortOrder - b.sortOrder || (a.itemId < b.itemId ? -1 : 1)

    // Only items with some text count — an empty row is what "add item"
    // inserts, and reads as nothing either side.
    const srcItems = [...byItem(sourceRows).values()].filter((item) => itemText(item) !== '').sort(bySort)
    const tgtItems = [...byItem(targetRows).values()].filter((item) => itemText(item) !== '').sort(bySort)
    out.emptySource += sourceRows.filter((row) => isEmpty(extractTextNodes(row.json))).length

    // The non-empty fields of the source items — what gets translated.
    const fields: PlannedField[] = []
    for (const item of srcItems) {
      for (const row of item.rows) {
        const texts = extractTextNodes(row.json)
        if (!isEmpty(texts)) fields.push(toField(row, texts))
      }
    }
    if (fields.length === 0) return null

    if (tgtItems.length === 0) {
      // Nothing of the owner's in the target list: fill it, reusing the
      // source's ids so the two lists stay aligned from here on.
      for (const field of fields) {
        out.missing.push(field)
        countNeutral(field.texts)
      }
      return null
    }

    const tgtById = new Map(tgtItems.map((item) => [item.itemId, item]))
    const srcIds = new Set(srcItems.map((item) => item.itemId))
    const source = srcItems.map((item) => {
      const target = tgtById.get(item.itemId)
      let status: 'shared' | 'changed' | 'new' = 'new'
      if (target) {
        const newest = (rows: TranslatableBlock[]) =>
          rows.reduce((max, row) => (isNewer(row.updatedAt, max) ? row.updatedAt : max), rows[0].updatedAt)
        const oldest = (rows: TranslatableBlock[]) =>
          rows.reduce((min, row) => (isNewer(min, row.updatedAt) ? row.updatedAt : min), rows[0].updatedAt)
        status = isNewer(newest(item.rows), oldest(target.rows)) ? 'changed' : 'shared'
      }
      return {
        itemId: item.itemId,
        text: itemText(item),
        sortOrder: item.sortOrder,
        keys: item.rows.filter((row) => !isEmpty(extractTextNodes(row.json))).map((row) => row.blockKey),
        status,
      }
    })
    const target = tgtItems.map((item) => ({
      itemId: item.itemId,
      text: itemText(item),
      sortOrder: item.sortOrder,
      shared: srcIds.has(item.itemId),
    }))

    const ownInTarget = target.some((item) => !item.shared)
    const sharedInTarget = target.some((item) => item.shared)
    const needsSync = source.some((item) => item.status !== 'shared')

    if (!ownInTarget && !needsSync) {
      out.unchanged += fields.length
      return null
    }

    const choices: ListChoice[] = []
    if (!ownInTarget) choices.push('sync')
    choices.push('replace')
    if (ownInTarget && sharedInTarget) choices.push('dedupe')

    const first = listItemOf(sourceRows[0].blockKey)!
    // "projects.items.<id>.narrative" → "projects.items.<id>.title", and the
    // same for a skills category's own name — so the review can say *which*
    // project's tags these are rather than an opaque id.
    const parentKey = prefix.startsWith('projects.items.')
      ? prefix.replace(/\.(narrative|tags)$/, '.title')
      : prefix.startsWith('skills.categories.')
        ? prefix.replace(/\.skills$/, '.category')
        : null
    const parent = parentKey ? allSources.get(parentKey) : undefined

    return {
      prefix,
      section: sourceRows[0].section,
      kind: first.kind,
      parentTitle: parent ? plainText(parent.json) : '',
      source,
      target,
      targetKeys: targetRows.map((row) => row.blockKey).sort(),
      fields,
      choices,
    }
  }
}

/** How many fields a run would fill directly (no review). */
export function plannedCount(plan: TranslationPlan): number {
  return plan.missing.length
}

/**
 * The fields a fill run works through: only `missing`. Stale fields and lists
 * with content go through review instead — see `reviewFields`.
 */
export function plannedFields(plan: TranslationPlan): PlannedField[] {
  return plan.missing
}

/**
 * What the review step needs translated before it can show anything: every
 * stale scalar, and every source field of every list under review (all of
 * them, so any of the list's choices can be previewed). Sorted and de-duped,
 * for the same "take the next N" chunking as a fill run.
 */
export function reviewFields(plan: TranslationPlan): PlannedField[] {
  const byKey = new Map<string, PlannedField>()
  for (const { current: _current, ...field } of plan.stale) {
    void _current
    byKey.set(field.blockKey, field)
  }
  for (const list of plan.lists) for (const field of list.fields) byKey.set(field.blockKey, field)
  return [...byKey.values()].sort((a, b) => (a.blockKey < b.blockKey ? -1 : a.blockKey > b.blockKey ? 1 : 0))
}
