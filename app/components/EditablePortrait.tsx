'use client'

import { useRef, useState } from 'react'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { useLang } from '../context/LanguageContext'
import { createClient } from '../lib/supabase/client'
import { savePortrait } from '../lib/portfolio-actions'
import { compressImage, uniqueUploadName, validateImageFile } from '../lib/image-upload'
import { storagePathFromPublicUrl } from '../lib/media-path'
import PositionPicker from './PositionPicker'

export default function EditablePortrait() {
  const { editing, media, content } = useLang()
  const inputRef = useRef<HTMLInputElement>(null)
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [uploadedPath, setUploadedPath] = useState<string | null>(null)
  const [position, setPosition] = useState<string | undefined>(undefined)
  const [positionMobile, setPositionMobile] = useState<string | undefined>(undefined)
  // Opened automatically right after a fresh upload — a photo crops
  // differently on mobile than on desktop, and nothing else would tell the
  // owner the mobile crop needs a look too (see PhotoCropModal's own
  // Desktop/Mobile hint, shown once this opens it).
  const [cropOpen, setCropOpen] = useState(false)

  const portrait = preview ?? media.portrait?.src ?? null
  const storagePath = uploadedPath ?? (media.portrait ? storagePathFromPublicUrl(media.portrait.src) : null)
  const rawPosition = position ?? media.portrait?.position
  // Falls back to the desktop position, not left undefined — a photo whose
  // owner has only ever set the one (desktop) focal point should still crop
  // sensibly on mobile rather than snapping to the crop tool's own
  // dead-center default.
  const rawPositionMobile = positionMobile ?? media.portrait?.positionMobile ?? rawPosition

  async function onPick(file: File) {
    if (busy) return
    setError(null)
    const invalid = validateImageFile(file)
    if (invalid) {
      setError(invalid)
      return
    }

    setBusy(true)
    try {
      const supabase = createClient()
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!user) throw new Error('Your session expired. Sign in again.')

      const image = await compressImage(file)
      const path = `${user.id}/portrait-${uniqueUploadName()}.webp`

      const upload = await supabase.storage
        .from('portfolio-media')
        .upload(path, image, { contentType: 'image/webp', upsert: false })
      if (upload.error) throw upload.error

      const saved = await savePortrait(path, content.hero.name)
      if (!saved.ok) throw new Error(saved.error)

      setPreview(URL.createObjectURL(image))
      setUploadedPath(path)
      setPosition(undefined)
      setPositionMobile(undefined)
      setCropOpen(true)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not upload that photo.')
    } finally {
      setBusy(false)
    }
  }

  async function onRotated(newStoragePath: string, newPublicUrl: string) {
    const saved = await savePortrait(newStoragePath, media.portrait?.alt ?? content.hero.name)
    if (!saved.ok) return saved
    setPreview(newPublicUrl)
    setUploadedPath(newStoragePath)
    setPosition(undefined)
    setPositionMobile(undefined)
    router.refresh()
    return { ok: true as const }
  }

  if (!editing && !portrait) return null

  return (
    // Below `md`, this box is no longer next to a sibling column to stretch
    // against (the grid collapses to one column), so `h-full` alone would
    // resolve against a row with no intrinsic height and the photo would
    // render at 0 height — a fixed `aspect-square` gives it a real height of
    // its own instead, sized off its own width. That width was originally
    // `w-full` (edge-to-edge), which pushed the name/tagline/description
    // below the fold on a phone screenshot — shrunk 30% to `w-[70%]`
    // (still centered by Hero's own `flex justify-center` wrapper) so more
    // of the text column is visible without scrolling.
    // From `md` up, unchanged: a fixed w-72 stretched to the text column's
    // height via the grid's items-stretch.
    <div className="relative w-[70%] md:w-72 aspect-square md:aspect-auto md:h-full md:min-h-80">
      {/* Subtle glow */}
      <div className="absolute inset-0 bg-dark-50/5 rounded-2xl blur-2xl scale-110" />

      <div className="relative w-full md:w-72 h-full rounded-2xl overflow-hidden border border-dark-600 group">
        {portrait ? (
          <>
            {/* Mobile position — the square box below `md` needs its own
                focal point, independent of the taller desktop crop below. */}
            <div className="md:hidden absolute inset-0">
              <Image
                src={portrait}
                alt={media.portrait?.alt ?? content.hero.name}
                fill
                quality={90}
                unoptimized={portrait.startsWith('blob:')}
                style={{ objectPosition: rawPositionMobile ?? '50% 0%' }}
                className="object-cover"
                priority
              />
            </div>
            {/* Desktop position */}
            <div className="hidden md:block absolute inset-0">
              <Image
                src={portrait}
                alt={media.portrait?.alt ?? content.hero.name}
                fill
                quality={90}
                unoptimized={portrait.startsWith('blob:')}
                style={{ objectPosition: rawPosition ?? '50% 0%' }}
                className="object-cover"
                priority
              />
            </div>
          </>
        ) : (
          <div className="absolute inset-0 grid place-items-center bg-dark-800 text-dark-500 text-sm">
            No photo yet
          </div>
        )}

        <div className="absolute bottom-0 inset-x-0 h-24 bg-gradient-to-t from-dark-900/60 to-transparent pointer-events-none" />

        {editing && (
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-3 bg-dark-900/70 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity py-2">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={busy}
              className="text-xs font-medium text-dark-50"
            >
              {busy ? 'Uploading…' : portrait ? 'Change photo' : 'Add photo'}
            </button>
          </div>
        )}

        {/* Direct child of the same relative box the photo fills, so the
            picker's full-cover overlay lines up with the whole photo. */}
        {editing && portrait && storagePath && (
          <PositionPicker
            storagePath={storagePath}
            src={portrait}
            alt={media.portrait?.alt ?? content.hero.name}
            // The portrait box is a fixed 18rem wide and stretches to the text
            // column's height — roughly this, whatever the copy length.
            aspect={0.62}
            position={rawPosition}
            onChange={setPosition}
            // The mobile box is a full-width square (see the wrapper above) —
            // a second, independently draggable square frame in the crop
            // modal, rather than reusing the desktop rectangle's position.
            mobileAspect={1}
            mobilePosition={rawPositionMobile}
            onChangeMobile={setPositionMobile}
            onRotated={onRotated}
            open={cropOpen}
            onOpenChange={setCropOpen}
            triggerClassName="absolute top-2 left-2 z-10 px-2 py-1 rounded-md bg-dark-900/70 text-dark-50 text-xs font-medium opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
          />
        )}
      </div>

      {editing && (
        <>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) onPick(file)
            }}
          />
          {error && <p className="mt-2 text-xs text-red-400 max-w-72">{error}</p>}
        </>
      )}
    </div>
  )
}
