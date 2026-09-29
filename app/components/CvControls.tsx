'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { removeCv, saveCv } from '../lib/cv/cv-actions'
import { uploadCvForReading, type CvUploadError } from '../lib/cv/upload-cv'

/**
 * The owner's controls for the downloadable CV (Navbar's "CV" button, which a
 * visitor opens and downloads): upload one when there's none, and replace or
 * remove it from inside the CV viewer. Owner-only, so the labels are English
 * like every other editing control; importing a CV (onboarding) also sets it.
 */

const ERRORS: Record<CvUploadError | 'save', string> = {
  not_pdf: 'Only PDF files',
  too_big: 'Max 8MB',
  not_signed_in: 'Session expired',
  upload_failed: 'Upload failed',
  save: 'Could not save',
}

function useCvUpload() {
  const router = useRouter()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onFile(file: File | undefined) {
    if (!file) return
    setBusy(true)
    setError(null)
    const uploaded = await uploadCvForReading(file, 'cv')
    if (!uploaded.ok) {
      setError(ERRORS[uploaded.error])
    } else {
      const saved = await saveCv(uploaded.path)
      if (saved.ok) router.refresh()
      else setError(ERRORS.save)
    }
    setBusy(false)
    if (input.current) input.current.value = ''
  }

  const picker = (
    <input
      ref={input}
      type="file"
      accept="application/pdf,.pdf"
      className="hidden"
      onChange={(e) => void onFile(e.target.files?.[0])}
    />
  )
  return { picker, open: () => input.current?.click(), busy, error }
}

/** Shown in the owner's Navbar when the portfolio has no CV yet. */
export function UploadCvButton({ variant }: { variant: 'nav' | 'menu' }) {
  const { picker, open, busy, error } = useCvUpload()
  return (
    <>
      {picker}
      <button
        type="button"
        onClick={open}
        disabled={busy}
        title="Upload the CV visitors can view and download"
        className={`${
          variant === 'menu' ? 'w-full justify-center text-sm py-2' : 'text-xs py-2 px-3'
        } inline-flex items-center gap-1.5 rounded-lg border border-dashed border-dark-500 text-dark-300 hover:text-dark-50 hover:border-dark-300 transition disabled:opacity-60 ${
          error ? 'text-red-300 border-red-400/40' : ''
        }`}
      >
        {busy ? 'Uploading…' : error ?? '+ Upload CV'}
      </button>
    </>
  )
}

/** Inside the CV viewer, for the owner: a public-file notice, Replace and Remove. */
export function CvOwnerBar({ onRemoved }: { onRemoved: () => void }) {
  const router = useRouter()
  const { picker, open, busy, error } = useCvUpload()
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)

  async function remove() {
    setRemoving(true)
    setRemoveError(null)
    const result = await removeCv()
    setRemoving(false)
    if (result.ok) {
      onRemoved()
      router.refresh()
    } else setRemoveError('Could not remove it')
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 border-b border-dark-700 bg-dark-900/60 text-xs">
      {picker}
      <p className="text-dark-400">
        {error ?? removeError ?? 'Anyone who visits your portfolio can view and download this file.'}
      </p>
      <div className="flex items-center gap-3">
        <button type="button" onClick={open} disabled={busy} className="text-dark-200 hover:text-dark-50 transition disabled:opacity-60">
          {busy ? 'Uploading…' : 'Replace'}
        </button>
        <button
          type="button"
          onClick={() => void remove()}
          disabled={removing}
          className="text-dark-400 hover:text-red-300 transition disabled:opacity-60"
        >
          {removing ? 'Removing…' : 'Remove'}
        </button>
      </div>
    </div>
  )
}
