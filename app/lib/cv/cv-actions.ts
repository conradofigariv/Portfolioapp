'use server'

import { createClient } from '../supabase/server'
import { readCvBytes, type CvReadResult } from './read-cv'

const BUCKET = 'portfolio-media'

/**
 * Read a CV the browser has just uploaded (upload-cv.ts) and return it as
 * cards for the import tray. **Writes nothing to the portfolio** — that's the
 * next step, after the owner picks what stays.
 *
 * Why the PDF goes through storage instead of this action's own argument: a
 * serverless function on Vercel accepts ~4.5MB per request and a server action
 * 1MB by default, and a CV with a photo in it easily passes that. The browser
 * uploads to the owner's own folder (the bucket's policies only allow that
 * folder), this reads it from there — and **deletes it** as soon as it's read,
 * whatever the outcome: the CV itself is never kept.
 *
 * Runs on the portfolio page, so the page's `maxDuration` (60s) applies — the
 * reader's own timeout (45s) fits inside it.
 */
export async function readCv(storagePath: string): Promise<CvReadResult | { ok: false; error: 'not_signed_in' | 'bad_path' }> {
  let supabase: Awaited<ReturnType<typeof createClient>> | null = null
  let path: string | null = null
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
    const bytes = new Uint8Array(await data.arrayBuffer())
    return await readCvBytes(bytes)
  } catch (err) {
    return { ok: false, error: 'failed', message: err instanceof Error ? err.message : undefined }
  } finally {
    if (supabase && path) await supabase.storage.from(BUCKET).remove([path]).catch(() => {})
  }
}
