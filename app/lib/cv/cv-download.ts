/**
 * The "Download CV" link. A plain `<a download>` is ignored by browsers when
 * the file lives on another origin (Supabase Storage), so it opened the PDF in
 * a new tab instead of downloading it. Supabase serves a public object as an
 * attachment when asked with `?download=<filename>` — used here with a tidy
 * name built from the owner's name. A file shipped in /public is same-origin,
 * where `download` already works, so it's left as it is.
 */
export function cvDownloadHref(src: string, ownerName: string): string {
  if (!src.includes('/storage/v1/object/public/')) return src
  const slug =
    ownerName
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'cv'
  const url = new URL(src)
  url.searchParams.set('download', `${slug}-cv.pdf`)
  return url.toString()
}
