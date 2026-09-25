'use server'

import { revalidatePath } from 'next/cache'
import type { JSONContent } from '@tiptap/core'
import { createClient } from '../supabase/server'
import { plainTextFromDoc, renderBlockHtml, sanitizeDoc } from '../editor/render-html'
import type { Lang } from '../portfolio'
import { removeCertificationFile } from '../portfolio-actions'
import {
  listItemOf,
  planTranslation,
  plannedFields,
  reviewFields,
  type ListReview,
  type PlannedField,
  type TranslatableBlock,
  type TranslationPlan,
} from './plan'
import {
  translateBatch,
  type ChunkFailure,
  type TranslatedItem,
  type Translator,
} from './translate-batch'
import { createGeminiTranslator } from './gemini-translator'

/**
 * Steps 4 and 6 of the AI translation feature: the server half of a run.
 *
 * A run has two parts, decided by the plan (plan.ts):
 *
 * 1. **Fill** (`translateChunk`) — fields with nothing in the target language
 *    yet, and lists whose target is empty. Written straight away: nothing the
 *    owner wrote can be overwritten by these.
 * 2. **Review** (`translateReviewChunk` + `applyTranslationReview`) — anything
 *    that already has content in the target language: a scalar field whose
 *    source was edited since it was translated, or a list whose target has its
 *    own items. Translated *without* writing, shown to the owner side by side,
 *    and only written for what they accept. Added after a real run duplicated
 *    every hand-written Spanish list item (see `ListReview` in plan.ts).
 *
 * Both parts are chunked the same way: the client calls repeatedly until
 * `done`, each call re-reads the rows, re-plans from scratch, takes the next
 * N, and makes **one** model call. A server action is a serverless function
 * with a wall-clock limit, and a portfolio has on the order of 100 fields — one
 * call for all of them is a guaranteed timeout on some hosting plans.
 */

// Same ceiling upsertBlock applies, for the same reason: a field here is a name
// or a tagline, and nothing should be able to store an unbounded document.
const MAX_BLOCK_LENGTH = 2000

// Clamped server-side rather than trusted from the client. The upper bound is
// about the time limit above (a bigger batch is one longer model call, not more
// calls), and about blast radius: one malformed answer fails at most this many
// fields, and they all come back on the next pass anyway.
const DEFAULT_CHUNK = 6
const MAX_CHUNK = 12

// Previews travel to the browser once per field; a snippet is all the panel
// shows, so there's no reason to ship a whole paragraph back.
const PREVIEW_LENGTH = 160
function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > PREVIEW_LENGTH ? `${flat.slice(0, PREVIEW_LENGTH - 1).trimEnd()}…` : flat
}

// A portfolio has on the order of a hundred fields; these only exist so a
// caller can't make the server build arbitrarily large sets or payloads.
const MAX_SKIP = 1000
const MAX_REVIEW_ITEMS = 1000

type BlockRow = {
  block_key: string
  section: string
  lang: string
  content_json: unknown
  sort_order: number
  updated_at: string
}

type Counts = {
  missing: number
  /** Stale scalar fields — they go to review. */
  stale: number
  /** Lists under review. */
  lists: number
  unchanged: number
  emptySource: number
  /** Of the planned fields, how many were copied as-is with no model call. */
  languageNeutral: number
}

export type TranslateChunkResult =
  | {
      ok: true
      /** Nothing left to translate for this part of the run. */
      done: boolean
      /** Fields this call translated (a fill chunk: written; a review chunk: translated, not written). */
      translated: number
      /** How many fields this call set out to do (its own chunk size). */
      attempted: number
      /**
       * Planned fields this run hasn't attempted yet — excluding both this
       * call's batch and everything in `skip`. `done` is exactly `remaining === 0`.
       */
      remaining: number
      /** Per-field reasons, each carrying the real error rather than a generic one. */
      failures: ChunkFailure[]
      /**
       * Every field this call translated, as readable before/after text — what
       * the panel shows live and in its end-of-run summary. On a review chunk
       * each also carries its `json`, for the client to hand back on apply.
       */
      written: TranslatedItem[]
      /** The model call itself failed — see `BatchResult.callError`. */
      callError?: string
      counts: Counts
    }
  | { ok: false; error: string }

/** Everything the review screen needs, as plain text — no documents, no keys it can't use. */
export type ReviewView = {
  fields: { blockKey: string; section: string; source: string; current: string }[]
  lists: {
    prefix: string
    section: string
    kind: ListReview['kind']
    parentTitle: string
    source: (ListReview['source'][number])[]
    target: (ListReview['target'][number])[]
  }[]
}

function validLangs(from: unknown, to: unknown): string | null {
  if (from !== 'en' && from !== 'es') return 'Unsupported source language.'
  if (to !== 'en' && to !== 'es') return 'Unsupported target language.'
  if (from === to) return 'Pick two different languages.'
  return null
}

/**
 * Auth, portfolio and the plan, the same way for every action here. The
 * portfolio comes from the session, never from an argument — that alone is
 * what stops any of these from being a way to rewrite someone else's page.
 */
async function loadPlan(from: Lang, to: Lang) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false as const, error: 'You are not signed in.' }

  const { data: portfolio } = await supabase
    .from('portfolios')
    .select('id')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!portfolio) return { ok: false as const, error: 'Your portfolio is still being set up.' }

  const { data: rows, error } = await supabase
    .from('portfolio_blocks')
    .select('block_key, section, lang, content_json, sort_order, updated_at')
    .eq('portfolio_id', portfolio.id)
    .in('lang', [from, to])
  if (error) return { ok: false as const, error: error.message }

  const blocks: TranslatableBlock[] = ((rows ?? []) as BlockRow[])
    .filter((row) => row.lang === from || row.lang === to)
    .map((row) => ({
      blockKey: row.block_key,
      section: row.section,
      lang: row.lang as Lang,
      json: (row.content_json ?? null) as TranslatableBlock['json'],
      updatedAt: row.updated_at,
      sortOrder: row.sort_order,
    }))

  const plan = planTranslation(blocks, from, to)
  return { ok: true as const, supabase, portfolioId: portfolio.id as string, plan }
}

function countsOf(plan: TranslationPlan): Counts {
  return {
    missing: plan.missing.length,
    stale: plan.stale.length,
    lists: plan.lists.length,
    unchanged: plan.unchanged,
    emptySource: plan.emptySource,
    languageNeutral: plan.languageNeutral,
  }
}

function clampLimit(requested: unknown): number {
  // `Number.isFinite` first, not just min/max: NaN passes straight through
  // both (`Math.max(1, NaN)` is NaN), and a NaN limit makes `slice(0, NaN)`
  // return nothing — the run would report zero progress with no error
  // anywhere. This is a server action, so the argument is whatever a caller
  // sends, not whatever the UI sends.
  return typeof requested === 'number' && Number.isFinite(requested)
    ? Math.min(MAX_CHUNK, Math.max(1, Math.trunc(requested)))
    : DEFAULT_CHUNK
}

function stringSet(value: unknown, max: number): Set<string> {
  // Non-strings are dropped rather than coerced; they can't name a block_key.
  return new Set(
    Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string').slice(0, max) : []
  )
}

type Upsertable = { blockKey: string; section: string; json: JSONContent; sortOrder: number }

/**
 * One upsert per field rather than a single array upsert: a batch write fails
 * as a unit, and losing per-field error attribution would mean reporting "the
 * chunk failed" instead of naming the field and the reason.
 */
async function writeFields(
  supabase: Awaited<ReturnType<typeof createClient>>,
  portfolioId: string,
  to: Lang,
  fields: Upsertable[]
): Promise<{ written: { field: Upsertable; safeJson: JSONContent }[]; failures: ChunkFailure[] }> {
  const written: { field: Upsertable; safeJson: JSONContent }[] = []
  const failures: ChunkFailure[] = []
  for (const field of fields) {
    // Sanitized and re-rendered here rather than trusting the document: this
    // is the same whitelist the editor's own save path runs, and the stored
    // `content_html` has to come from the stored JSON or the public page and
    // the editor would show different things.
    const safeJson = sanitizeDoc(field.json, MAX_BLOCK_LENGTH)
    const { error } = await supabase.from('portfolio_blocks').upsert(
      {
        portfolio_id: portfolioId,
        block_key: field.blockKey,
        lang: to,
        section: field.section,
        content_json: safeJson,
        content_html: renderBlockHtml(safeJson),
        // Written explicitly because `upsertBlock` does not — a translated
        // list item would otherwise land on the column default and scramble
        // the target language's list order.
        sort_order: field.sortOrder,
      },
      { onConflict: 'portfolio_id,block_key,lang' }
    )
    // `updated_at` is left to the table's own touch trigger, so the target
    // row always ends up newer than the source it was translated from — which
    // is precisely what makes the field read as current until the owner edits
    // the source again (see plan.ts on staleness).
    if (error) failures.push({ blockKey: field.blockKey, error: error.message, section: field.section })
    else written.push({ field, safeJson })
  }
  return { written, failures }
}

/**
 * The shared body of a fill chunk and a review chunk: re-plan, take the next
 * N of `queueOf(plan)` not in `skip`, one model call. `write` decides whether
 * the answers are stored (fill) or only handed back (review).
 */
async function runChunk(
  options: { from: Lang; to: Lang; limit?: number; skip?: string[] },
  queueOf: (plan: TranslationPlan) => PlannedField[],
  write: boolean
): Promise<TranslateChunkResult> {
  // Same convention as every other write path in this app: always resolve,
  // never reject, and surface the *real* message — the caller's own catch can
  // only ever say "something failed", which is undiagnosable from a screenshot.
  try {
    const { from, to } = options
    const invalid = validLangs(from, to)
    if (invalid) return { ok: false, error: invalid }
    const limit = clampLimit(options.limit)
    const skip = stringSet(options.skip, MAX_SKIP)

    const loaded = await loadPlan(from, to)
    if (!loaded.ok) return loaded
    const { supabase, portfolioId, plan } = loaded
    const counts = countsOf(plan)

    const queue = queueOf(plan).filter((field) => !skip.has(field.blockKey))
    if (queue.length === 0) {
      return { ok: true, done: true, translated: 0, attempted: 0, remaining: 0, failures: [], written: [], counts }
    }

    const batch = queue.slice(0, limit)
    const translator: Translator = createGeminiTranslator()
    const result = await translateBatch(batch, from, to, translator)

    const byKey = new Map(batch.map((field) => [field.blockKey, field]))
    const sourceText = (blockKey: string) => snippet(byKey.get(blockKey)?.texts.join('') ?? '')
    const failures: ChunkFailure[] = result.failed.map((f) => ({
      ...f,
      section: byKey.get(f.blockKey)?.section,
      source: sourceText(f.blockKey),
    }))
    const items: TranslatedItem[] = []

    if (write) {
      const stored = await writeFields(supabase, portfolioId, to, result.translated)
      for (const f of stored.failures) failures.push({ ...f, source: sourceText(f.blockKey) })
      for (const { field, safeJson } of stored.written) {
        items.push({
          blockKey: field.blockKey,
          section: field.section,
          source: sourceText(field.blockKey),
          // From the document actually stored, not the model's raw answer.
          result: snippet(plainTextFromDoc(safeJson)),
        })
      }
      // The public page renders from these rows, so the new language only
      // shows up after a revalidate. Once per chunk rather than per field.
      if (stored.written.length > 0) revalidatePath('/', 'layout')
    } else {
      for (const field of result.translated) {
        const safeJson = sanitizeDoc(field.json, MAX_BLOCK_LENGTH)
        items.push({
          blockKey: field.blockKey,
          section: field.section,
          source: sourceText(field.blockKey),
          result: snippet(plainTextFromDoc(safeJson)),
          json: safeJson,
        })
      }
    }

    // Everything in this batch has now been attempted, written or not — the
    // failures (and, on a review run, the successes too, since nothing was
    // written to take them out of the plan) go into the client's `skip`.
    const remaining = queue.length - batch.length
    return {
      ok: true,
      done: remaining === 0,
      translated: items.length,
      attempted: batch.length,
      remaining,
      failures,
      written: items,
      ...(result.callError ? { callError: result.callError } : {}),
      counts,
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Unexpected error while translating.',
    }
  }
}

/**
 * One chunk of the fill part of a run — written straight away.
 *
 * `skip` is the fields that already failed earlier in the *same run*. A failed
 * field deliberately leaves its target row untouched, so it comes back as
 * `missing` on the very next plan — right for the owner's *next* run, wrong
 * within one: the plan is sorted, so the fields that just failed are also the
 * first ones the next chunk would pick again, and one batch that keeps failing
 * would block every field sorted after it (surfaced live as "0 of 124" on
 * every click). Nothing about `skip` is stored: a new run starts with every
 * field eligible again.
 */
export async function translateChunk(options: {
  from: Lang
  to: Lang
  limit?: number
  skip?: string[]
}): Promise<TranslateChunkResult> {
  return runChunk(options, plannedFields, true)
}

/**
 * One chunk of the review part of a run — translated, **not written**. Each
 * item carries its `json`; the client holds them until the owner applies.
 * `skip` must include every field already attempted (succeeded or not), since
 * nothing here takes a field out of the plan.
 */
export async function translateReviewChunk(options: {
  from: Lang
  to: Lang
  limit?: number
  skip?: string[]
}): Promise<TranslateChunkResult> {
  return runChunk(options, reviewFields, false)
}

/**
 * What a run would do, without doing any of it and without a model call: the
 * counts for the start screen, and the review view (current target text,
 * source text, how each list lines up) for the review step.
 */
export async function previewTranslation(options: {
  from: Lang
  to: Lang
}): Promise<({ ok: true; review: ReviewView } & Counts) | { ok: false; error: string }> {
  try {
    const { from, to } = options
    const invalid = validLangs(from, to)
    if (invalid) return { ok: false, error: invalid }

    const loaded = await loadPlan(from, to)
    if (!loaded.ok) return loaded
    const { plan } = loaded

    const review: ReviewView = {
      fields: plan.stale.map((field) => ({
        blockKey: field.blockKey,
        section: field.section,
        source: snippet(field.texts.join('')),
        current: snippet(field.current),
      })),
      lists: plan.lists.map((list) => ({
        prefix: list.prefix,
        section: list.section,
        kind: list.kind,
        parentTitle: snippet(list.parentTitle),
        source: list.source.map((item) => ({ ...item, text: snippet(item.text) })),
        target: list.target.map((item) => ({ ...item, text: snippet(item.text) })),
      })),
    }
    return { ok: true, review, ...countsOf(plan) }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Unexpected error while checking what to translate.',
    }
  }
}

export type ApplyReviewResult =
  | {
      ok: true
      /** What was written, for the end-of-run summary. */
      written: TranslatedItem[]
      /** How many list items were removed (left out of a list's final selection). */
      removed: number
      failures: ChunkFailure[]
    }
  | { ok: false; error: string }

/**
 * Write what the owner accepted on the review screen.
 *
 * For each list, the client sends the **final list as an ordered sequence of
 * item references** — `{from: 'target', itemId}` keeps an item already on the
 * page, `{from: 'source', itemId}` writes the new translation of a source
 * item (list-merge.ts builds these from the owner's picks). Everything else is
 * decided here from a fresh plan, never from the request: every referenced id
 * has to exist in *this* list right now (a crafted request can't touch rows
 * outside it, and a list that changed since the preview is reported instead of
 * half-applied), which rows get deleted is "every row of this list whose item
 * isn't in the sequence", and every item's sort_order becomes its position.
 */
export async function applyTranslationReview(options: {
  from: Lang
  to: Lang
  fields: string[]
  lists: { prefix: string; items: { from: 'target' | 'source'; itemId: string }[] }[]
  translations: { blockKey: string; json: JSONContent }[]
}): Promise<ApplyReviewResult> {
  try {
    const { from, to } = options
    const invalid = validLangs(from, to)
    if (invalid) return { ok: false, error: invalid }

    const accepted = stringSet(options.fields, MAX_REVIEW_ITEMS)
    type Ref = { from: 'target' | 'source'; itemId: string }
    const decisions = new Map<string, Ref[] | null>()
    if (Array.isArray(options.lists)) {
      for (const entry of options.lists.slice(0, MAX_REVIEW_ITEMS)) {
        if (!entry || typeof entry.prefix !== 'string') continue
        const items = Array.isArray(entry.items) ? entry.items.slice(0, MAX_REVIEW_ITEMS) : null
        const valid =
          items &&
          items.every(
            (ref) =>
              ref && (ref.from === 'target' || ref.from === 'source') && typeof ref.itemId === 'string' && ref.itemId
          )
        // null marks a malformed entry, reported below rather than dropped silently.
        decisions.set(entry.prefix, valid ? (items as Ref[]) : null)
      }
    }
    const docs = new Map<string, JSONContent>()
    if (Array.isArray(options.translations)) {
      for (const entry of options.translations.slice(0, MAX_REVIEW_ITEMS)) {
        if (entry && typeof entry.blockKey === 'string' && entry.json && typeof entry.json === 'object') {
          docs.set(entry.blockKey, entry.json)
        }
      }
    }

    const loaded = await loadPlan(from, to)
    if (!loaded.ok) return loaded
    const { supabase, portfolioId, plan } = loaded

    const writes: Upsertable[] = []
    const deletes: string[] = []
    const failures: ChunkFailure[] = []
    const orphanedCerts: string[] = []

    // Stale scalar fields.
    const staleByKey = new Map(plan.stale.map((field) => [field.blockKey, field]))
    for (const blockKey of accepted) {
      const field = staleByKey.get(blockKey)
      const json = docs.get(blockKey)
      if (!field) {
        failures.push({ blockKey, error: 'This field changed since the preview — run the translation again.' })
      } else if (!json) {
        failures.push({ blockKey, error: 'No translation was provided for this field.', section: field.section })
      } else {
        writes.push({ blockKey, section: field.section, json, sortOrder: field.sortOrder })
      }
    }

    // Lists.
    const listByPrefix = new Map(plan.lists.map((list) => [list.prefix, list]))
    const reorders: { keys: string[]; sortOrder: number }[] = []
    let removedItems = 0
    const changed = (prefix: string) =>
      failures.push({ blockKey: prefix, error: 'This list changed since the preview — run the translation again.' })
    for (const [prefix, refs] of decisions) {
      const list = listByPrefix.get(prefix)
      if (!list || !refs) {
        changed(prefix)
        continue
      }
      const targetById = new Map(list.target.map((item) => [item.itemId, item]))
      const sourceById = new Map(list.source.map((item) => [item.itemId, item]))
      const ids = refs.map((ref) => ref.itemId)
      const known = refs.every((ref) => (ref.from === 'target' ? targetById : sourceById).has(ref.itemId))
      // The same item twice (kept *and* rewritten, or listed twice) can't be
      // one list's content — list-merge never produces it, so it's a request
      // that doesn't match this list.
      if (!known || new Set(ids).size !== ids.length) {
        changed(prefix)
        continue
      }

      const needed = refs.filter((ref) => ref.from === 'source').flatMap((ref) => sourceById.get(ref.itemId)!.keys)
      const missing = needed.filter((key) => !docs.has(key))
      if (missing.length > 0) {
        // All or nothing per list: half of a chosen list is worse than none.
        failures.push({
          blockKey: prefix,
          error: `${missing.length} item(s) of this list weren't translated — retry the translation.`,
          section: list.section,
        })
        continue
      }

      const fieldByKey = new Map(list.fields.map((field) => [field.blockKey, field]))
      const written = new Set<string>()
      refs.forEach((ref, index) => {
        if (ref.from === 'source') {
          for (const key of sourceById.get(ref.itemId)!.keys) {
            const field = fieldByKey.get(key)!
            // sort_order is the item's position in the owner's final order.
            writes.push({ blockKey: key, section: field.section, json: docs.get(key)!, sortOrder: index })
            written.add(key)
          }
        } else {
          reorders.push({ keys: targetById.get(ref.itemId)!.keys, sortOrder: index })
        }
      })

      // Every row of this list whose item isn't in the final sequence goes —
      // plus, for an item being rewritten, any old field the new translation
      // doesn't have (a certification whose issuer is now empty).
      const finalIds = new Set(ids)
      const sourceIds = new Set(list.source.map((item) => item.itemId))
      const gone = new Set<string>()
      for (const key of list.targetKeys) {
        const itemId = listItemOf(key)?.itemId ?? ''
        if (!finalIds.has(itemId)) {
          deletes.push(key)
          gone.add(itemId)
        } else if (refs.some((ref) => ref.from === 'source' && ref.itemId === itemId) && !written.has(key)) {
          deletes.push(key)
        }
      }
      removedItems += gone.size
      // A certification's uploaded file is keyed by its item id, not by
      // language: one whose id only ever existed in the target list (written
      // there by hand) is gone for good once it's left out, so its file goes
      // too — the same orphan cleanup the certification's own remove button
      // does. A shared id's file belongs to the source's item as well and stays.
      if (list.kind === 'certs') {
        for (const itemId of gone) if (!sourceIds.has(itemId)) orphanedCerts.push(itemId)
      }
    }

    // Deletes first, so a list never briefly shows both its old and new items.
    if (deletes.length > 0) {
      const { error } = await supabase
        .from('portfolio_blocks')
        .delete()
        .eq('portfolio_id', portfolioId)
        .eq('lang', to)
        .in('block_key', deletes)
      if (error) return { ok: false, error: error.message }
    }
    for (const certId of orphanedCerts) await removeCertificationFile(certId)

    // Kept items move to their position in the owner's order.
    const reordered = await Promise.all(
      reorders.map(({ keys, sortOrder }) =>
        supabase
          .from('portfolio_blocks')
          .update({ sort_order: sortOrder })
          .eq('portfolio_id', portfolioId)
          .eq('lang', to)
          .in('block_key', keys)
      )
    )
    const reorderError = reordered.find((result) => result.error)?.error
    if (reorderError) failures.push({ blockKey: 'order', error: reorderError.message })

    const stored = await writeFields(supabase, portfolioId, to, writes)
    failures.push(...stored.failures)

    if (stored.written.length > 0 || deletes.length > 0 || reorders.length > 0) revalidatePath('/', 'layout')

    const sourceText = new Map(
      [...plan.stale, ...plan.lists.flatMap((list) => list.fields)].map((f) => [f.blockKey, snippet(f.texts.join(''))])
    )
    return {
      ok: true,
      written: stored.written.map(({ field, safeJson }) => ({
        blockKey: field.blockKey,
        section: field.section,
        source: sourceText.get(field.blockKey) ?? '',
        result: snippet(plainTextFromDoc(safeJson)),
      })),
      removed: removedItems,
      failures,
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Unexpected error while applying the translation.',
    }
  }
}
