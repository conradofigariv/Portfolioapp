import type { SupabaseClient } from '@supabase/supabase-js'
import type { JSONContent } from '@tiptap/core'
import type { Lang } from '../portfolio'
import { isContent, normalizeContent } from '../portfolio-db'
import { parseCvExtract, NotACvError } from './cv-parse'
import { planCvImport, type BlockTexts, type CvImportPlan, type CvImportSummary } from './cv-import-plan'
import { plainTextFromDoc } from '../editor/render-html'

const BUCKET = 'portfolio-media'

export type CvImportResult =
  | { ok: true; summary: CvImportSummary }
  | { ok: false; error: 'not_a_cv' | 'no_portfolio' | 'failed'; message?: string }

/**
 * Carries out a CV import (see cv-import-plan.ts for *what* it does). Not a
 * server action — the caller (`importCv` in cv-actions.ts) does the auth — so
 * it takes the client and is checked offline against a fake one.
 *
 * The CV comes from the browser (it's what `readCv` returned a moment ago), so
 * it's run through `parseCvExtract` again: the same caps, the same private-data
 * scrub, the same "no number the CV didn't state" rule, whatever was sent.
 *
 * Order matters, so a failure halfway leaves a page that still makes sense:
 * 1. the new blocks, in one upsert (atomic — all or none);
 * 2. the single starter rows that go;
 * 3. the structure (`portfolios.content`) that makes the new entities appear
 *    and the old ones disappear;
 * 4. the removed entities' blocks and files, best effort — at that point
 *    nothing references them any more, so a failure only leaves orphans,
 *    never a broken page.
 */
export async function executeCvImport(
  supabase: SupabaseClient,
  { userId, cv: raw, includeEmail, stamp }: { userId: string; cv: unknown; includeEmail: boolean; stamp: string }
): Promise<CvImportResult> {
  let cv
  try {
    cv = parseCvExtract(raw)
  } catch (err) {
    if (err instanceof NotACvError) return { ok: false, error: 'not_a_cv' }
    throw err
  }

  const { data: portfolio, error: portfolioError } = await supabase
    .from('portfolios')
    .select('id, content')
    .eq('user_id', userId)
    .maybeSingle()
  if (portfolioError) return { ok: false, error: 'failed', message: portfolioError.message }
  const stored = portfolio?.content as Partial<Record<Lang, unknown>> | null | undefined
  if (!portfolio || !stored || !isContent(stored.en) || !isContent(stored.es)) return { ok: false, error: 'no_portfolio' }
  const content = { en: normalizeContent(stored.en), es: normalizeContent(stored.es) }

  const { data: blockRows, error: blocksError } = await supabase
    .from('portfolio_blocks')
    .select('block_key, lang, content_json')
    .eq('portfolio_id', portfolio.id)
  if (blocksError) return { ok: false, error: 'failed', message: blocksError.message }
  const texts: BlockTexts = {}
  for (const row of (blockRows ?? []) as { block_key: string; lang: Lang; content_json: JSONContent }[]) {
    ;(texts[row.block_key] ??= {})[row.lang] = plainTextFromDoc(row.content_json)
  }

  const plan: CvImportPlan = planCvImport({ cv, content, texts, includeEmail, stamp })
  const portfolioId = portfolio.id as string

  // 1. new blocks
  if (plan.upserts.length) {
    const { error } = await supabase
      .from('portfolio_blocks')
      .upsert(
        plan.upserts.map((row) => ({ ...row, portfolio_id: portfolioId })),
        { onConflict: 'portfolio_id,block_key,lang' }
      )
    if (error) return { ok: false, error: 'failed', message: error.message }
  }

  // 2. starter rows
  for (const lang of ['en', 'es'] as const) {
    const keys = plan.deletes.filter((d) => d.lang === lang).map((d) => d.blockKey)
    if (!keys.length) continue
    const { error } = await supabase
      .from('portfolio_blocks')
      .delete()
      .eq('portfolio_id', portfolioId)
      .eq('lang', lang)
      .in('block_key', keys)
    if (error) return { ok: false, error: 'failed', message: error.message }
  }

  // 3. structure
  const { error: contentError } = await supabase
    .from('portfolios')
    .update({ content: plan.content, published: true })
    .eq('id', portfolioId)
  if (contentError) return { ok: false, error: 'failed', message: contentError.message }

  // 4. what was removed — best effort
  try {
    await removeEntities(supabase, portfolioId, plan.removed)
  } catch (err) {
    console.error('importCv cleanup failed', { portfolioId, err })
  }

  return { ok: true, summary: plan.summary }
}

async function removeEntities(supabase: SupabaseClient, portfolioId: string, removed: CvImportPlan['removed']) {
  const prefixes: { prefix: string; lang?: Lang }[] = [
    ...removed.projects.map((id) => ({ prefix: `projects.items.${id}.` })),
    ...removed.chapters.map((id) => ({ prefix: `journey.chapters.${id}.` })),
    ...removed.certs.map((id) => ({ prefix: `skills.certs.${id}.` })),
    ...removed.categories.map(({ id, lang }) => ({ prefix: `skills.categories.${id}.`, lang })),
  ]
  await Promise.all(
    prefixes.map(({ prefix, lang }) => {
      let query = supabase.from('portfolio_blocks').delete().eq('portfolio_id', portfolioId).like('block_key', `${prefix}%`)
      if (lang) query = query.eq('lang', lang)
      return query
    })
  )

  const targets = [
    ...removed.projects.map((id) => ({ kind: 'project', id })),
    ...removed.chapters.map((id) => ({ kind: 'chapter', id })),
    ...removed.certs.map((id) => ({ kind: 'certification', id })),
  ]
  if (!targets.length) return
  const { data: media } = await supabase
    .from('portfolio_media')
    .select('id, kind, target_id, storage_path')
    .eq('portfolio_id', portfolioId)
    .in('kind', ['project', 'chapter', 'certification'])
    .in('target_id', targets.map((t) => t.id))
  const rows = ((media ?? []) as { id: string; kind: string; target_id: string; storage_path: string }[]).filter((row) =>
    targets.some((t) => t.kind === row.kind && t.id === row.target_id)
  )
  if (!rows.length) return
  await supabase.from('portfolio_media').delete().in('id', rows.map((row) => row.id))
  // A "/..." path is a file shipped with the app (adoptDeploymentMedia), not in the bucket.
  const owned = rows.map((row) => row.storage_path).filter((path) => !path.startsWith('/'))
  if (owned.length) await supabase.storage.from(BUCKET).remove(owned)
}
