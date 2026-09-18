'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { saveMediaPosition } from '../lib/portfolio-actions'
import PhotoCropModal from './PhotoCropModal'

// The "Adjust position" affordance: a small trigger the caller places over the
// photo, which opens the crop modal. The modal is portalled to <body>, so this
// can sit anywhere in the tree without its overlay being clipped or trapped by
// a transformed ancestor.
export default function PositionPicker({
  storagePath,
  src,
  alt,
  aspect,
  position,
  onChange,
  mobileAspect,
  mobilePosition,
  onChangeMobile,
  onRotated,
  triggerClassName = 'text-xs font-medium text-dark-50',
  open: controlledOpen,
  onOpenChange,
}: {
  storagePath: string
  src: string
  alt: string
  // Width / height of the box this photo is cropped into on the page.
  aspect: number
  position?: string
  onChange: (position: string) => void
  // See PhotoCropModal — providing all three adds a second, independently
  // draggable frame + a Desktop/Mobile tab switcher for a photo that sits in
  // a differently-shaped box on mobile than on desktop.
  mobileAspect?: number
  mobilePosition?: string
  onChangeMobile?: (position: string) => void
  // Re-encodes the photo rotated 90° and points the stored row at the
  // result. Omit to hide the rotate control (e.g. for photos with no
  // dedicated save action to call).
  onRotated?: (
    newStoragePath: string,
    newPublicUrl: string
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  triggerClassName?: string
  // Both optional — when omitted this manages its own open state exactly as
  // before (every caller but EditablePortrait). EditablePortrait controls
  // this to auto-open the modal right after a fresh upload, since a photo
  // with two differently-shaped crops otherwise has no visible sign the
  // mobile one needs setting too until the owner happens to check mobile.
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const [internalOpen, setInternalOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const router = useRouter()
  const isControlled = controlledOpen !== undefined
  const open = isControlled ? controlledOpen : internalOpen
  const setOpen = isControlled ? onOpenChange! : setInternalOpen
  const hasMobileFrame = mobileAspect !== undefined && onChangeMobile !== undefined

  async function done() {
    setSaving(true)
    const result = await saveMediaPosition(
      storagePath,
      position ?? '50% 50%',
      hasMobileFrame ? mobilePosition ?? '50% 50%' : undefined
    )
    setSaving(false)
    setOpen(false)
    if (result.ok) router.refresh()
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={triggerClassName}>
        Adjust position
      </button>

      {open && (
        <PhotoCropModal
          src={src}
          alt={alt}
          aspect={aspect}
          position={position}
          onChange={onChange}
          mobileAspect={mobileAspect}
          mobilePosition={mobilePosition}
          onChangeMobile={onChangeMobile}
          onDone={done}
          saving={saving}
          storagePath={storagePath}
          onRotated={onRotated}
        />
      )}
    </>
  )
}
