import type { SupabaseClient } from '@supabase/supabase-js'

const BUCKET = 'portfolio-media'

/**
 * The portfolio's downloadable CV — the PDF behind Navbar's "CV" button, which
 * a visitor (a recruiter) can view and download. One per portfolio
 * (`portfolio_media.kind = 'cv'`, the media-limit trigger's default of 1).
 *
 * Shared by the owner's own upload (`saveCv` in cv-actions.ts) and the CV
 * import (`readCv`), which keeps the PDF it just read as the CV rather than
 * deleting it: the file a candidate imports is exactly the one a recruiter
 * wants. Not a server action — callers do the auth checks.
 */
export async function setPortfolioCv(
  supabase: SupabaseClient,
  { userId, storagePath }: { userId: string; storagePath: string }
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Storage policies key off the first path segment, so a file outside the
  // caller's own folder could never have been written in the first place.
  if (!storagePath.startsWith(`${userId}/`) || !storagePath.endsWith('.pdf') || storagePath.includes('..')) {
    return { ok: false, error: 'That file does not belong to your account.' }
  }
  const { data: portfolio } = await supabase.from('portfolios').select('id').eq('user_id', userId).maybeSingle()
  if (!portfolio) return { ok: false, error: 'Your portfolio is still being set up.' }

  const { data: previous } = await supabase
    .from('portfolio_media')
    .select('id, storage_path')
    .eq('portfolio_id', portfolio.id)
    .eq('kind', 'cv')

  // Remove the old row first: the database allows only one CV, so an insert
  // alongside a leftover row would be rejected. A path starting with "/" is a
  // file shipped in /public (adoptDeploymentMedia), not a bucket object.
  if (previous?.length) {
    await supabase.from('portfolio_media').delete().in('id', previous.map((row) => row.id))
    const owned = previous.map((row) => row.storage_path).filter((p) => !p.startsWith('/') && p !== storagePath)
    if (owned.length) await supabase.storage.from(BUCKET).remove(owned)
  }

  const { error } = await supabase.from('portfolio_media').insert({
    portfolio_id: portfolio.id,
    kind: 'cv',
    target_id: null,
    storage_path: storagePath,
    alt: 'CV',
  })
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

export async function removePortfolioCv(
  supabase: SupabaseClient,
  { userId }: { userId: string }
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: portfolio } = await supabase.from('portfolios').select('id').eq('user_id', userId).maybeSingle()
  if (!portfolio) return { ok: false, error: 'Your portfolio is still being set up.' }
  const { data: rows } = await supabase
    .from('portfolio_media')
    .select('id, storage_path')
    .eq('portfolio_id', portfolio.id)
    .eq('kind', 'cv')
  if (rows?.length) {
    await supabase.from('portfolio_media').delete().in('id', rows.map((row) => row.id))
    const owned = rows.map((row) => row.storage_path).filter((p) => !p.startsWith('/'))
    if (owned.length) await supabase.storage.from(BUCKET).remove(owned)
  }
  return { ok: true }
}
