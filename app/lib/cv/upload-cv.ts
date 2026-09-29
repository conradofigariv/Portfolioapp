import { createClient } from '../supabase/client'
import { uniqueUploadName } from '../image-upload'
import { MAX_CV_BYTES } from './cv-limits'

/**
 * Browser half of uploading a CV: checks the file (a PDF, ≤ 8MB) and uploads
 * it to the owner's own folder, returning the path for `readCv` or `saveCv`.
 * See cv-actions.ts for why it goes through storage rather than an action's
 * own argument.
 */
export type CvUploadError = 'not_pdf' | 'too_big' | 'not_signed_in' | 'upload_failed'

/**
 * `purpose` names the file: `cv-import-*` is what `readCv` accepts (read, then
 * kept as the CV if it is one), `cv-*` is a plain upload for `saveCv`.
 */
export async function uploadCvForReading(
  file: File,
  purpose: 'import' | 'cv' = 'import'
): Promise<{ ok: true; path: string } | { ok: false; error: CvUploadError }> {
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
  if (!isPdf) return { ok: false, error: 'not_pdf' }
  if (file.size > MAX_CV_BYTES) return { ok: false, error: 'too_big' }

  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'not_signed_in' }

  const path = `${user.id}/${purpose === 'import' ? 'cv-import' : 'cv'}-${uniqueUploadName()}.pdf`
  const { error } = await supabase.storage
    .from('portfolio-media')
    .upload(path, file, { contentType: 'application/pdf', upsert: false })
  if (error) return { ok: false, error: 'upload_failed' }
  return { ok: true, path }
}
