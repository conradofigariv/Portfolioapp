'use client'

import { useState } from 'react'
import { useLang } from '../context/LanguageContext'
import { buildPdfModel } from '../lib/pdf/model'

/**
 * "Download PDF" — the portfolio as an A4 portrait document, in the language
 * currently on screen. For everyone: a visitor (a recruiter taking the page
 * with them) and the owner alike, which is why it lives in Navbar rather than
 * the owner-only EditBar. For the owner it also includes edits not saved yet,
 * since it's built from the same client state the page renders.
 *
 * The heavy part (react-pdf, fonts, the document) is loaded by export.ts only
 * when this is clicked. `buildPdfModel` is imported statically because it's a
 * few KB of plain functions.
 */
export default function DownloadPdfButton({ variant }: { variant: 'nav' | 'menu' }) {
  const { t, lang, content, blocks, media } = useLang()
  const [state, setState] = useState<'idle' | 'working' | 'error'>('idle')

  async function onClick() {
    if (state === 'working') return
    setState('working')
    try {
      const { exportPortfolioPdf } = await import('../lib/pdf/export')
      // The page's own address, so the PDF links back to exactly what the
      // reader was looking at (a root-domain portfolio lives at "/").
      const url = `${window.location.origin}${window.location.pathname}`.replace(/\/$/, '')
      const model = buildPdfModel({ lang, content, blocks, media, url })
      await exportPortfolioPdf({
        model,
        labels: {
          certifications: t.skills.certifications,
          email: t.pdf.email,
          page: t.pdf.page,
          livePortfolio: t.pdf.livePortfolio,
        },
        username: window.location.pathname.split('/').filter(Boolean).pop() ?? 'portfolio',
      })
      setState('idle')
    } catch (err) {
      console.error('PDF export failed', err)
      setState('error')
      setTimeout(() => setState('idle'), 4000)
    }
  }

  const label = state === 'working' ? t.pdf.preparing : state === 'error' ? t.pdf.failed : null

  if (variant === 'menu') {
    return (
      <button
        type="button"
        onClick={() => void onClick()}
        disabled={state === 'working'}
        className="button-secondary inline-flex items-center justify-center gap-2 text-center text-sm disabled:opacity-60"
      >
        <DownloadIcon spinning={state === 'working'} />
        {label ?? t.pdf.download}
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={() => void onClick()}
      disabled={state === 'working'}
      title={label ?? t.pdf.download}
      aria-label={label ?? t.pdf.download}
      // Icon-only between md and lg: in edit mode this row also carries the
      // background picker and "sign out", and at 768px the label alone pushed
      // it past the viewport edge. The aria-label/title keep it named.
      className={`button-secondary inline-flex items-center gap-1.5 text-sm py-2 px-3 lg:px-6 disabled:opacity-60 ${
        state === 'error' ? 'text-red-300' : ''
      }`}
    >
      <DownloadIcon spinning={state === 'working'} />
      <span className="hidden lg:inline">{state === 'working' ? t.pdf.preparing : t.pdf.short}</span>
    </button>
  )
}

function DownloadIcon({ spinning }: { spinning: boolean }) {
  if (spinning) {
    return (
      <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
    )
  }
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19h14" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
