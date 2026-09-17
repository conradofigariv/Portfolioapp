'use client'

import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createClient } from '../lib/supabase/client'
import { rotateImage, uniqueUploadName } from '../lib/image-upload'

function clamp(n: number) {
  return Math.max(0, Math.min(100, n))
}

function parsePosition(position?: string): [number, number] {
  const [x, y] = (position ?? '50% 50%')
    .split(' ')
    .map((v) => parseFloat(v))
    .map((v) => (Number.isFinite(v) ? v : 50))
  return [x ?? 50, y ?? 50]
}

/**
 * The whole photo, with a draggable frame showing exactly the part that
 * survives the crop on the page. The frame's shape is the shape of the box the
 * photo is displayed in, and everything outside it is dimmed — so what you see
 * inside the frame is what the visitor sees.
 *
 * The frame's travel is the same thing CSS object-position expresses: with the
 * photo scaled to cover the box, one axis has slack, and the percentage says
 * how much of that slack sits before the visible window.
 */
export default function PhotoCropModal({
  src,
  alt,
  aspect,
  position,
  onChange,
  mobileAspect,
  mobilePosition,
  onChangeMobile,
  onDone,
  saving = false,
  storagePath,
  onRotated,
}: {
  src: string
  alt: string
  // Width / height of the box this photo gets cropped into on the page.
  aspect: number
  position?: string
  onChange: (position: string) => void
  // The same photo can sit in a differently-shaped box on mobile (e.g. the
  // hero portrait: square below `md`, a tall rectangle from `md` up) — one
  // crop frame can't represent both. Providing these three adds a second,
  // independent frame + a tab switcher to move between them; omit all three
  // to keep the single-frame behavior every other caller still uses.
  mobileAspect?: number
  mobilePosition?: string
  onChangeMobile?: (position: string) => void
  onDone: () => void
  saving?: boolean
  // Needed to re-encode a rotated copy under the same account folder and
  // point the stored row at it. Rotation is optional — omit both to hide it.
  storagePath?: string
  onRotated?: (
    newStoragePath: string,
    newPublicUrl: string
  ) => Promise<{ ok: true } | { ok: false; error: string }>
}) {
  const hasMobileFrame = mobileAspect !== undefined && onChangeMobile !== undefined
  const [mode, setMode] = useState<'desktop' | 'mobile'>('desktop')
  const activeAspect = hasMobileFrame && mode === 'mobile' ? mobileAspect : aspect
  const activePosition = hasMobileFrame && mode === 'mobile' ? mobilePosition : position
  const activeOnChange = hasMobileFrame && mode === 'mobile' ? onChangeMobile! : onChange

  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const drag = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [rotating, setRotating] = useState(false)
  const [rotateError, setRotateError] = useState<string | null>(null)

  // The rotated re-encode is a different file at a different natural size —
  // wait for the new one to load rather than keep showing the old frame math.
  const [knownSrc, setKnownSrc] = useState(src)
  if (src !== knownSrc) {
    setKnownSrc(src)
    setNatural(null)
  }

  async function handleRotate() {
    if (rotating || saving || !storagePath || !onRotated) return
    setRotateError(null)
    setRotating(true)
    try {
      const blob = await rotateImage(src, 90)
      const supabase = createClient()
      const folder = storagePath.split('/')[0]
      const newPath = `${folder}/${uniqueUploadName()}.webp`

      const upload = await supabase.storage
        .from('portfolio-media')
        .upload(newPath, blob, { contentType: 'image/webp', upsert: false })
      if (upload.error) throw upload.error

      const { data } = supabase.storage.from('portfolio-media').getPublicUrl(newPath)
      const result = await onRotated(newPath, data.publicUrl)
      if (!result.ok) throw new Error(result.error)

      // The old frame position(s) described a photo shape that no longer
      // applies once width/height swap.
      onChange('50% 50%')
      if (hasMobileFrame) onChangeMobile!('50% 50%')
    } catch (err) {
      setRotateError(err instanceof Error ? err.message : 'Could not rotate that photo.')
    } finally {
      setRotating(false)
    }
  }

  const [x, y] = parsePosition(activePosition)

  // The visible window, as a share of the photo. Only the axis with slack
  // shrinks; the other one always spans the whole photo.
  let frameW = 100
  let frameH = 100
  if (natural) {
    const imageAspect = natural.w / natural.h
    if (imageAspect > activeAspect) frameW = (activeAspect / imageAspect) * 100
    else frameH = (imageAspect / activeAspect) * 100
  }

  const left = ((100 - frameW) * x) / 100
  const top = ((100 - frameH) * y) / 100

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (rotating) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY, startX: x, startY: y }
    setDragging(true)
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const start = drag.current
    const image = imageRef.current
    if (!start || !image) return

    const rect = image.getBoundingClientRect()
    // Slack in pixels: what the frame can actually travel across.
    const slackX = (rect.width * (100 - frameW)) / 100
    const slackY = (rect.height * (100 - frameH)) / 100

    const nextX = slackX > 0 ? clamp(start.startX + ((e.clientX - start.x) / slackX) * 100) : 50
    const nextY = slackY > 0 ? clamp(start.startY + ((e.clientY - start.y) / slackY) * 100) : 50
    activeOnChange(`${Math.round(nextX)}% ${Math.round(nextY)}%`)
  }

  function onPointerUp() {
    drag.current = null
    setDragging(false)
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/85 p-4"
      onClick={onDone}
    >
      <div
        className="flex flex-col items-center gap-3 max-w-full"
        onClick={(e) => e.stopPropagation()}
      >
        {hasMobileFrame && (
          <div className="flex items-center gap-1 rounded-lg border border-dark-600 p-0.5 text-xs font-mono">
            <button
              type="button"
              onClick={() => setMode('desktop')}
              className={`px-3 py-1 rounded-md transition ${
                mode === 'desktop' ? 'bg-dark-50 text-dark-900 font-bold' : 'text-dark-400 hover:text-dark-50'
              }`}
            >
              Desktop
            </button>
            <button
              type="button"
              onClick={() => setMode('mobile')}
              className={`px-3 py-1 rounded-md transition ${
                mode === 'mobile' ? 'bg-dark-50 text-dark-900 font-bold' : 'text-dark-400 hover:text-dark-50'
              }`}
            >
              Mobile
            </button>
          </div>
        )}

        <div className="flex items-center gap-3">
          <p className="text-xs text-dark-300 text-center">
            {rotating
              ? 'Rotating…'
              : natural
              ? 'Drag the frame to choose what stays visible'
              : 'Opening editor…'}
          </p>
          {storagePath && onRotated && (
            <button
              type="button"
              onClick={handleRotate}
              disabled={!natural || rotating || saving}
              title="Rotate 90°"
              className="text-dark-300 hover:text-dark-50 disabled:opacity-40 disabled:hover:text-dark-300 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 4v5h5M20 20v-5h-5M4.5 9a8 8 0 0113.9-3.4L20 9M19.5 15a8 8 0 01-13.9 3.4L4 15"
                />
              </svg>
            </button>
          )}
        </div>
        {rotateError && <p className="text-xs text-red-400 text-center max-w-72">{rotateError}</p>}

        <div className="relative inline-block leading-none select-none min-h-[40vh] min-w-[40vw]">
          {(!natural || rotating) && (
            <div className="absolute inset-0 flex items-center justify-center z-10">
              <div className="w-8 h-8 rounded-full border-2 border-dark-500 border-t-dark-50 animate-spin" />
            </div>
          )}
          {/* A plain img: it sizes itself to the photo's own proportions inside
              the max box, so the frame below can be positioned in percentages
              of the photo rather than of a letterboxed container. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={imageRef}
            src={src}
            alt={alt}
            onLoad={(e) =>
              setNatural({
                w: e.currentTarget.naturalWidth,
                h: e.currentTarget.naturalHeight,
              })
            }
            className={`block max-h-[70vh] max-w-[min(92vw,900px)] rounded-lg transition-opacity ${
              natural ? 'opacity-100' : 'opacity-0'
            }`}
            draggable={false}
          />

          {natural && (
            <div
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              style={{
                left: `${left}%`,
                top: `${top}%`,
                width: `${frameW}%`,
                height: `${frameH}%`,
                cursor: dragging ? 'grabbing' : 'grab',
                // Dims everything outside the frame without needing four
                // separate overlay panels.
                boxShadow: '0 0 0 9999px rgba(0,0,0,0.62)',
              }}
              className="absolute touch-none border-2 border-dark-50 rounded-sm"
            >
              <div className="absolute inset-0 border border-dark-900/40" />
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={onDone}
          className="button-primary text-sm py-1.5 px-5 disabled:opacity-60"
          disabled={saving || rotating}
        >
          {saving ? 'Saving…' : 'Done'}
        </button>
      </div>
    </div>,
    document.body
  )
}
