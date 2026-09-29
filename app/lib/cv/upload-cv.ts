import { createClient } from '../supabase/client'
import { uniqueUploadName } from '../image-upload'
import { MAX_CV_BYTES } from './cv-limits'

/**
 * Browser half of reading a CV: checks the file, uploads it to the owner's
 * own folder as a temporary `cv-import-*.pdf`, and returns the path for
 * `readCv` — which deletes it once read. See cv-actions.ts for why it goes
 * through storage rather than the action's own argument.
 */
export async function uploadCvForReading(
  file: File
): Promise<{ ok: true; path: string } | { ok: false; error: 'not_pdf' | 'too_big' | 'not_signed_in' | 'upload_failed' }> {
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
  if (!isPdf) return { ok: false, error: 'not_pdf' }
  if (file.size > MAX_CV_BYTES) return { ok: false, error: 'too_big' }

  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'not_signed_in' }

  const path = `${user.id}/cv-import-${uniqueUploadName()}.pdf`
  const { error } = await supabase.storage
    .from('portfolio-media')
    .upload(path, file, { contentType: 'application/pdf', upsert: false })
  if (error) return { ok: false, error: 'upload_failed' }
  return { ok: true, path }
}
