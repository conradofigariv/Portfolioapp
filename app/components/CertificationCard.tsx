'use client'

import { useRef, useState } from 'react'
import Image from 'next/image'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { useLang } from '../context/LanguageContext'
import { createClient } from '../lib/supabase/client'
import { saveCertificationFile, removeCertificationFile } from '../lib/portfolio-actions'
import {
  PDF_TYPE,
  compressImage,
  uniqueUploadName,
  validateCertificationFile,
} from '../lib/image-upload'
import { RemoveButton } from './EditControls'

// The stored source is either a PDF or an image, and they render through
// completely different elements — an <iframe> vs an <Image>. Nothing in
// portfolio_media records which one it is, so the extension the upload below
// assigns (always .pdf or .webp, never the original filename) is what tells
// them apart. A Supabase public URL carries no query string, so checking the
// tail of the string is enough.
function isPdfSource(src: string) {
  return src.toLowerCase().endsWith('.pdf')
}

/**
 * One certification: its title/issuer fields, and the optional file behind
 * them — the certificate itself, which a visitor opens by clicking the card.
 *
 * The click target is deliberately only wired up when *not* editing. The card
 * is full of contentEditable fields in edit mode, and an outer click/keydown
 * handler around those is the exact shape that already ate space bar
 * keystrokes once in ProjectTimeline (see CLAUDE.md). The owner gets explicit
 * View/Replace/Remove controls instead, so there's nothing to bubble into.
 */
export default function CertificationCard({
  certId,
  title,
  children,
  onRemove,
  removing = false,
}: {
  certId: string
  // Plain-text title, only for the file's alt text and the viewer's heading —
  // the rendered title is a rich text field, passed in as children.
  title: string
  children: React.ReactNode
  onRemove: () => void
  removing?: boolean
}) {
  const { editing, media, t } = useLang()
  const inputRef = useRef<HTMLInputElement>(null)
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  const file = media.certFiles[certId] ?? null
  const label = title.trim() || t.skills.certifications

  async function onPick(picked: File) {
    if (busy) return
    setError(null)
    const invalid = validateCertificationFile(picked)
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

      // A PDF goes up byte for byte; only a photo of a certificate is worth
      // running through the shared WebP compression every other upload uses.
      const isPdf = picked.type === PDF_TYPE
      const body = isPdf ? picked : await compressImage(picked)
      const path = `${user.id}/cert-${uniqueUploadName()}.${isPdf ? 'pdf' : 'webp'}`

      const upload = await supabase.storage
        .from('portfolio-media')
        .upload(path, body, { contentType: isPdf ? PDF_TYPE : 'image/webp', upsert: false })
      if (upload.error) throw upload.error

      const saved = await saveCertificationFile(certId, path, label)
      if (!saved.ok) throw new Error(saved.error)

      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not upload that file.')
    } finally {
      setBusy(false)
    }
  }

  async function onRemoveFile() {
    if (busy) return
    setBusy(true)
    setError(null)
    const result = await removeCertificationFile(certId)
    setBusy(false)
    if (result.ok) router.refresh()
    else setError(result.error)
  }

  const clickable = !editing && !!file
  const cardClassName = `flex items-start gap-3 md:gap-4 bg-dark-900/50 p-4 md:p-6 rounded-xl border border-dark-700 hover:border-dark-500 transition ${
    clickable ? 'cursor-pointer text-left w-full' : ''
  }`

  return (
    <>
      <div
        className={cardClassName}
        {...(clickable
          ? {
              role: 'button',
              tabIndex: 0,
              'aria-label': `${t.skills.viewCertificate}: ${label}`,
              onClick: () => setOpen(true),
              onKeyDown: (e: React.KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setOpen(true)
                }
              },
            }
          : {})}
      >
        <span className="text-lg md:text-xl flex-shrink-0">📜</span>
        <div className="flex-1 min-w-0">
          {children}

          {/* A visitor gets one quiet hint that there's something to open;
              the whole card is the click target, so this is a cue, not a
              second control. */}
          {clickable && (
            <span className="mt-2 inline-flex items-center gap-1 text-dark-400 text-xs">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.5 12S5.5 5.5 12 5.5 21.5 12 21.5 12 18.5 18.5 12 18.5 2.5 12 2.5 12z"
                />
              </svg>
              {t.skills.viewCertificate}
            </span>
          )}

          {editing && (
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                disabled={busy}
                className="text-xs font-medium text-dark-300 hover:text-dark-50 transition disabled:opacity-60"
              >
                {busy ? 'Uploading…' : file ? 'Replace file' : 'Add file (PDF or photo)'}
              </button>
              {file && (
                <>
                  <button
                    type="button"
                    onClick={() => setOpen(true)}
                    className="text-xs font-medium text-dark-300 hover:text-dark-50 transition"
                  >
                    View
                  </button>
                  <button
                    type="button"
                    onClick={onRemoveFile}
                    disabled={busy}
                    className="text-xs text-red-400/90 hover:text-red-400 transition disabled:opacity-60"
                  >
                    Remove file
                  </button>
                </>
              )}
              <input
                ref={inputRef}
                type="file"
                accept="application/pdf,image/*"
                hidden
                onChange={(e) => {
                  const picked = e.target.files?.[0]
                  e.target.value = ''
                  if (picked) onPick(picked)
                }}
              />
              {error && <p className="w-full text-xs text-red-400">{error}</p>}
            </div>
          )}
        </div>

        {editing && (
          <RemoveButton label="Remove certification" disabled={removing} onClick={onRemove} />
        )}
      </div>

      {open &&
        file &&
        createPortal(
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4"
            onClick={() => setOpen(false)}
          >
            <div
              className="bg-dark-800 border border-dark-700 rounded-xl w-full max-w-4xl flex flex-col overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-dark-700">
                <span className="text-dark-50 font-semibold text-sm truncate">{label}</span>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <a href={file.src} download className="button-secondary text-sm py-1.5">
                    {t.skills.downloadCertificate}
                  </a>
                  <button
                    onClick={() => setOpen(false)}
                    aria-label={t.skills.closeCertificate}
                    className="text-dark-300 hover:text-dark-50 transition p-1.5 rounded-lg hover:bg-dark-700/60"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                  </button>
                </div>
              </div>

              {isPdfSource(file.src) ? (
                <iframe
                  src={`${file.src}#view=FitH`}
                  title={label}
                  className="w-full h-[70vh] md:h-[78vh] bg-white"
                />
              ) : (
                <div className="relative h-[50vh] md:h-[65vh] bg-dark-900">
                  <Image
                    src={file.src}
                    alt={file.alt || label}
                    fill
                    quality={90}
                    className="object-contain"
                  />
                </div>
              )}
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
