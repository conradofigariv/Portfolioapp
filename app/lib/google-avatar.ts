import type { SupabaseClient } from '@supabase/supabase-js'

const BUCKET = 'portfolio-media'
const MAX_BYTES = 5 * 1024 * 1024
const TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }

/**
 * A new account starts with its Google photo as the portrait, so the first
 * page an owner sees has a face on it instead of an empty "Add photo" box.
 *
 * The photo is **copied into our own bucket** as an ordinary portrait row,
 * not hot-linked: from then on it behaves exactly like an upload — the crop
 * tool, "Change photo", removing it, and the PDF export (which fetches each
 * image from the browser) all work with no special case, and it doesn't
 * depend on a Google URL staying valid.
 *
 * Only on the owner's **first** open (the caller passes whether this load
 * just seeded the starter blocks, see starter-blocks.ts). After that it never
 * runs again, so an owner who removes the photo doesn't get it back.
 */

/** Google serves avatars at `…=s96-c`; ask for a size fit for a portrait. Only Google's own host is accepted. */
export function largeGoogleAvatarUrl(url: unknown, size = 800): string | null {
  if (typeof url !== 'string') return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.googleusercontent.com')) return null
  const href = parsed.toString()
  return /=s\d+(-c)?$/.test(href) ? href.replace(/=s\d+(-c)?$/, `=s${size}-c`) : `${href}=s${size}-c`
}

export async function adoptGoogleAvatar(
  supabase: SupabaseClient,
  {
    portfolioId,
    userId,
    avatarUrl,
    alt,
    fetchImpl = fetch,
  }: { portfolioId: string; userId: string; avatarUrl: unknown; alt: string; fetchImpl?: typeof fetch }
): Promise<boolean> {
  const url = largeGoogleAvatarUrl(avatarUrl)
  if (!url) return false
  try {
    const { count } = await supabase
      .from('portfolio_media')
      .select('id', { count: 'exact', head: true })
      .eq('portfolio_id', portfolioId)
      .eq('kind', 'portrait')
    if (count && count > 0) return false

    const res = await fetchImpl(url, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return false
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim()
    const ext = TYPES[type]
    if (!ext) return false
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) return false

    const path = `${userId}/portrait-google-${Date.now()}.${ext}`
    const { error: uploadError } = await supabase.storage.from(BUCKET).upload(path, bytes, { contentType: type })
    if (uploadError) return false

    const { error } = await supabase.from('portfolio_media').insert({
      portfolio_id: portfolioId,
      kind: 'portrait',
      target_id: null,
      storage_path: path,
      alt: alt.slice(0, 200),
    })
    if (error) {
      // Don't leave a file behind that no row points at.
      await supabase.storage.from(BUCKET).remove([path])
      return false
    }
    return true
  } catch (err) {
    // Never block the page over a photo: at worst the owner adds one by hand.
    console.error('adoptGoogleAvatar failed', { portfolioId, err })
    return false
  }
}
