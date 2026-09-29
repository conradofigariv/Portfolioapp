'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '../supabase/server'
import { readCvBytes, type CvReadResult } from './read-cv'
import { removePortfolioCv, setPortfolioCv } from './cv-store'

const BUCKET = 'portfolio-media'

/**
 * Read a CV the browser has just uploaded (upload-cv.ts) and return it as
 * cards for the import tray. Writes nothing to the portfolio's *text* — that's
 * the next step, after the owner picks what stays.
 *
 * Why the PDF goes through storage instead of this action's own argument: a
 * serverless function on Vercel accepts ~4.5MB per request and a server action
 * 1MB by default, and a CV with a photo in it easily passes that. The browser
 * uploads to the owner's own folder (the bucket's policies only allow that
 * folder), and this reads it from there.
 *
 * **A PDF that reads as a CV is kept as the portfolio's downloadable CV**
 * (Navbar's "CV" button, replacing any previous one) — the file a candidate
 * imports is exactly the one a recruiter wants to download. Anything that
 * doesn't (not a PDF, not a CV, the reader failing) is deleted: it isn't
 * something the owner meant to publish.
 *
 * Runs on the portfolio page, so the page's `maxDuration` (60s) applies — the
 * reader's own timeout (45s) fits inside it.
 */
export async function readCv(
  storagePath: string
): Promise<(CvReadResult & { keptAsCv?: boolean }) | { ok: false; error: 'not_signed_in' | 'bad_path' }> {
  let supabase: Awaited<ReturnType<typeof createClient>> | null = null
  let path: string | null = null
  let keep = false
  try {
    supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return { ok: false, error: 'not_signed_in' }

    // Only the caller's own temporary CV upload — never another file, never
    // someone else's folder (the bucket's own policies would refuse too).
    if (
      typeof storagePath !== 'string' ||
      !storagePath.startsWith(`${user.id}/cv-import-`) ||
      !storagePath.endsWith('.pdf') ||
      storagePath.includes('..')
    ) {
      return { ok: false, error: 'bad_path' }
    }
    path = storagePath

    const { data, error } = await supabase.storage.from(BUCKET).download(path)
    if (error || !data) return { ok: false, error: 'failed', message: error?.message }
    const result = await readCvBytes(new Uint8Array(await data.arrayBuffer()))
    if (!result.ok) return result

    const saved = await setPortfolioCv(supabase, { userId: user.id, storagePath: path })
    keep = saved.ok
    if (keep) revalidatePath('/', 'layout')
    return { ...result, keptAsCv: keep }
  } catch (err) {
    return { ok: false, error: 'failed', message: err instanceof Error ? err.message : undefined }
  } finally {
    if (supabase && path && !keep) await supabase.storage.from(BUCKET).remove([path]).catch(() => {})
  }
}

/** The owner uploads (or replaces) their downloadable CV directly, without importing it. */
export async function saveCv(storagePath: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return { ok: false, error: 'You are not signed in.' }
    const saved = await setPortfolioCv(supabase, { userId: user.id, storagePath })
    if (saved.ok) revalidatePath('/', 'layout')
    return saved
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not save the CV.' }
  }
}

export async function removeCv(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return { ok: false, error: 'You are not signed in.' }
    const removed = await removePortfolioCv(supabase, { userId: user.id })
    if (removed.ok) revalidatePath('/', 'layout')
    return removed
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not remove the CV.' }
  }
}
