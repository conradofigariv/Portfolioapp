const MAX_EDGE = 1920
const TARGET_BYTES = 3 * 1024 * 1024

/**
 * Resizes and re-encodes an image in the browser, so what reaches storage is
 * a predictable size rather than whatever the camera (or a full-resolution
 * screenshot) produced. Shared by every photo upload on the site (portrait,
 * chapter, project).
 *
 * Quality never drops below .85 (raised from an original floor of .78 after
 * a report that project preview photos still looked a bit soft) — screenshots
 * (sharp text, flat UI edges) show visible blocking at lower settings far
 * more than a photo does at the same setting. Missing the byte target by
 * keeping quality high is the better trade for this kind of image; the byte
 * target itself was raised alongside it (1.5MB -> 3MB) so the higher-quality
 * steps actually have room to be picked instead of always falling through.
 */
// Step the quality down rather than ever falling back to the original file,
// so a stored photo has a predictable ceiling.
async function canvasToWebp(canvas: HTMLCanvasElement): Promise<Blob> {
  let best: Blob | null = null
  for (const quality of [0.95, 0.9, 0.85]) {
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/webp', quality)
    )
    if (!blob) continue
    best = blob
    if (blob.size <= TARGET_BYTES) break
  }

  if (!best) throw new Error('Could not process that image. Try a different one.')
  return best
}

export async function compressImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)

  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser cannot process images. Try another one.')
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)

  return canvasToWebp(canvas)
}

/**
 * Re-encodes a stored photo rotated by a multiple of 90°, for photos that
 * came out sideways (a vertical shot cropped into a wide frame, or the
 * reverse). Fetches the current image fresh rather than taking a src prop
 * blindly, so repeated rotations always start from the latest bytes.
 */
export async function rotateImage(src: string, degrees: 90 | 180 | 270): Promise<Blob> {
  const res = await fetch(src)
  const blob = await res.blob()
  const bitmap = await createImageBitmap(blob)

  const swapped = degrees === 90 || degrees === 270
  const canvas = document.createElement('canvas')
  canvas.width = swapped ? bitmap.height : bitmap.width
  canvas.height = swapped ? bitmap.width : bitmap.height

  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser cannot process images. Try another one.')
  ctx.translate(canvas.width / 2, canvas.height / 2)
  ctx.rotate((degrees * Math.PI) / 180)
  ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2)

  return canvasToWebp(canvas)
}

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

export function validateImageFile(file: File): string | null {
  if (!file.type.startsWith('image/')) return 'That file is not an image.'
  if (file.size > MAX_UPLOAD_BYTES) return 'That image is over 10MB. Pick a smaller one.'
  return null
}

export const PDF_TYPE = 'application/pdf'

/**
 * A certificate can be a PDF as well as a photo — the only upload in this app
 * that isn't an image. A PDF is stored as-is (compressImage is a canvas →
 * WebP round trip, meaningless for a document), so unlike an image it has no
 * compression step to pull it back under the bucket's own 10MB ceiling: the
 * size check here is the only thing standing between the owner and a storage
 * rejection they'd have no context for.
 */
export function validateCertificationFile(file: File): string | null {
  const isPdf = file.type === PDF_TYPE
  if (!isPdf && !file.type.startsWith('image/')) return 'That file is not a PDF or an image.'
  if (file.size > MAX_UPLOAD_BYTES) {
    return isPdf
      ? 'That PDF is over 10MB. Pick a smaller one.'
      : 'That image is over 10MB. Pick a smaller one.'
  }
  return null
}

// Date.now() alone can collide: a fast double-click fires two uploads in the
// same millisecond, and Supabase Storage rejects the second with "The
// resource already exists" (upsert is intentionally off). The random suffix
// makes that practically impossible.
export function uniqueUploadName(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}
