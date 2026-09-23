'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '../supabase/server'
import { renderBlockHtml, sanitizeDoc } from '../editor/render-html'
import type { Lang } from '../portfolio'
import { planTranslation, plannedFields, type TranslatableBlock } from './plan'
import { translateBatch, type FieldFailure, type Translator } from './translate-batch'
import { createGeminiTranslator } from './gemini-translator'

/**
 * Step 4: one chunk of a translation run.
 *
 * The client calls this repeatedly until `done`. Each call re-reads the rows,
 * re-plans from scratch, takes the next N fields, makes **one** model call, and
 * writes what came back — see plan.ts for why "take the next N from a freshly
 * recomputed plan" needs no cursor and is resumable for free.
 *
 * Why chunks at all: a server action is a serverless function with a wall-clock
 * limit, and a portfolio has on the order of 80 translatable fields. One call
 * for all of them is a guaranteed timeout on some hosting plans. Chunking gets
 * progress, resumability and timeout safety out of the same mechanism, with no
 * queue, no job table and no polling.
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

type BlockRow = {
  block_key: string
  section: string
  lang: string
  content_json: unknown
  sort_order: number
  updated_at: string
}

export type TranslateChunkResult =
  | {
      ok: true
      /** Nothing left to translate for this direction. */
      done: boolean
      /** Fields written by this call. Zero with `done: false` means no progress — see below. */
      translated: number
      /** How many fields this call set out to do (its own chunk size). */
      attempted: number
      /** Still planned after this call, for a progress bar. */
      remaining: number
      /** Per-field reasons, each carrying the real error rather than a generic one. */
      failures: FieldFailure[]
      counts: {
        missing: number
        stale: number
        unchanged: number
        emptySource: number
        /** Of the planned fields, how many were copied as-is with no model call. */
        languageNeutral: number
      }
    }
  | { ok: false; error: string }

/**
 * `translated === 0 && !done` is the signal the client loop must stop on.
 *
 * A failed field deliberately leaves its target row untouched, so it comes back
 * as `missing` on the very next plan — which is exactly what makes a transient
 * failure self-healing, and what would make a *permanent* one (a model that
 * keeps answering this particular field in the wrong shape) loop forever. The
 * action can't tell those apart from inside a single chunk; the caller can, by
 * noticing that a whole chunk moved nothing.
 */
export async function translateChunk(options: {
  from: Lang
  to: Lang
  includeStale?: boolean
  limit?: number
}): Promise<TranslateChunkResult> {
  // Same convention as every other write path in this app: always resolve,
  // never reject, and surface the *real* message — the caller's own catch can
  // only ever say "something failed", which is undiagnosable from a screenshot.
  try {
    const { from, to } = options
    if (from !== 'en' && from !== 'es') return { ok: false, error: 'Unsupported source language.' }
    if (to !== 'en' && to !== 'es') return { ok: false, error: 'Unsupported target language.' }
    if (from === to) return { ok: false, error: 'Pick two different languages.' }

    const includeStale = options.includeStale === true
    // `Number.isFinite` first, not just min/max: NaN passes straight through
    // both (`Math.max(1, NaN)` is NaN), and a NaN limit makes `slice(0, NaN)`
    // return nothing — the run would report zero progress and the client loop
    // would stop, with no error anywhere. This is a server action, so the
    // argument is whatever a caller sends, not whatever the UI sends.
    const requested = options.limit
    const limit = Number.isFinite(requested)
      ? Math.min(MAX_CHUNK, Math.max(1, Math.trunc(requested as number)))
      : DEFAULT_CHUNK

    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return { ok: false, error: 'You are not signed in.' }

    // The portfolio comes from the session, never from an argument — that alone
    // is what stops this from being a way to rewrite someone else's page.
    const { data: portfolio } = await supabase
      .from('portfolios')
      .select('id')
      .eq('user_id', user.id)
      .maybeSingle()
    if (!portfolio) return { ok: false, error: 'Your portfolio is still being set up.' }

    const { data: rows, error: readError } = await supabase
      .from('portfolio_blocks')
      .select('block_key, section, lang, content_json, sort_order, updated_at')
      .eq('portfolio_id', portfolio.id)
      .in('lang', [from, to])
    if (readError) return { ok: false, error: readError.message }

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
    const queue = plannedFields(plan, includeStale)
    const counts = {
      missing: plan.missing.length,
      stale: plan.stale.length,
      unchanged: plan.unchanged,
      emptySource: plan.emptySource,
      languageNeutral: plan.languageNeutral,
    }

    if (queue.length === 0) {
      return { ok: true, done: true, translated: 0, attempted: 0, remaining: 0, failures: [], counts }
    }

    const batch = queue.slice(0, limit)
    const translator: Translator = createGeminiTranslator()
    const result = await translateBatch(batch, from, to, translator)

    const failures: FieldFailure[] = [...result.failed]
    let written = 0

    // One upsert per field rather than a single array upsert: a batch write
    // fails as a unit, and losing per-field error attribution here would mean
    // reporting "the chunk failed" instead of naming the field and the reason.
    // At this chunk size the extra round trips are noise next to one model call.
    for (const field of result.translated) {
      // Sanitized and re-rendered here rather than trusting the rebuilt
      // document: this is the same whitelist the editor's own save path runs,
      // and the stored `content_html` has to come from the stored JSON or the
      // public page and the editor would show different things.
      const safeJson = sanitizeDoc(field.json, MAX_BLOCK_LENGTH)
      const { error } = await supabase.from('portfolio_blocks').upsert(
        {
          portfolio_id: portfolio.id,
          block_key: field.blockKey,
          lang: field.lang,
          section: field.section,
          content_json: safeJson,
          content_html: renderBlockHtml(safeJson),
          // Written explicitly because `upsertBlock` does not — a translated
          // list item would otherwise land on the column default and scramble
          // the target language's list order. This is the reason
          // `PlannedField.sortOrder` is carried all the way through.
          sort_order: field.sortOrder,
        },
        { onConflict: 'portfolio_id,block_key,lang' }
      )
      // `updated_at` is left to the table's own touch trigger, so the target
      // row always ends up newer than the source it was translated from — which
      // is precisely what makes the field read as current until the owner edits
      // the source again (see plan.ts on staleness).
      if (error) failures.push({ blockKey: field.blockKey, error: error.message })
      else written++
    }

    // The public page renders from these rows, so the new language only shows
    // up after a revalidate. Done once per chunk rather than per field.
    if (written > 0) revalidatePath('/', 'layout')

    const remaining = Math.max(0, queue.length - written)
    return {
      ok: true,
      done: remaining === 0,
      translated: written,
      attempted: batch.length,
      remaining,
      failures,
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
 * What a run would do, without doing any of it and without a model call.
 *
 * The same plan the chunks work from, so the owner can see "12 fields to fill,
 * 3 out of date" before deciding — and so the progress UI has a total to count
 * against from the start rather than discovering it one chunk at a time.
 */
export async function previewTranslation(options: {
  from: Lang
  to: Lang
}): Promise<
  | { ok: true; missing: number; stale: number; unchanged: number; emptySource: number; languageNeutral: number }
  | { ok: false; error: string }
> {
  try {
    const { from, to } = options
    if (from !== 'en' && from !== 'es') return { ok: false, error: 'Unsupported source language.' }
    if (to !== 'en' && to !== 'es') return { ok: false, error: 'Unsupported target language.' }
    if (from === to) return { ok: false, error: 'Pick two different languages.' }

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

    const { data: rows, error } = await supabase
      .from('portfolio_blocks')
      .select('block_key, section, lang, content_json, sort_order, updated_at')
      .eq('portfolio_id', portfolio.id)
      .in('lang', [from, to])
    if (error) return { ok: false, error: error.message }

    const plan = planTranslation(
      ((rows ?? []) as BlockRow[]).map((row) => ({
        blockKey: row.block_key,
        section: row.section,
        lang: row.lang as Lang,
        json: (row.content_json ?? null) as TranslatableBlock['json'],
        updatedAt: row.updated_at,
        sortOrder: row.sort_order,
      })),
      from,
      to
    )

    return {
      ok: true,
      missing: plan.missing.length,
      stale: plan.stale.length,
      unchanged: plan.unchanged,
      emptySource: plan.emptySource,
      languageNeutral: plan.languageNeutral,
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Unexpected error while checking what to translate.',
    }
  }
}
