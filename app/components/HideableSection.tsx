'use client'

import type { ReactNode } from 'react'
import { useLang } from '../context/LanguageContext'
import { hiddenSectionsOf, type HideableSection as SectionId } from '../lib/portfolio'

/** Where each section's name comes from — the same label its nav link shows. */
const NAV_KEY = { journey: 'about', projects: 'projects', skills: 'skills', contact: 'contact' } as const
/** Each section's anchor — the collapsed bar takes it over, so the owner's nav link still lands somewhere. */
const ANCHOR = { journey: 'about', projects: 'projects', skills: 'skills', contact: 'contact' } as const

/**
 * Wraps one page section so the owner can hide it — for profiles the fixed
 * layout doesn't fit (no projects to show, no certifications, …).
 *
 * - A visitor never sees a hidden section at all (Navbar drops its link too).
 * - The owner sees it collapsed to a single bar that says it's hidden, with
 *   "Show" to bring it back — never gone without a trace, or they'd have no
 *   way to find it again.
 * - A visible section gets a small "Hide section" control in its top-right
 *   corner while editing.
 *
 * Hiding is structure, not text, so it goes through `updateBoth` — the same
 * section is hidden in both languages — and is saved with EditBar's Save,
 * exactly like adding or removing a project.
 */
export default function HideableSection({ id, children }: { id: SectionId; children: ReactNode }) {
  const { t, content, editing, updateBoth } = useLang()
  const hidden = hiddenSectionsOf(content).includes(id)
  const label = t.nav[NAV_KEY[id]]

  const setHidden = (next: boolean) =>
    updateBoth((current) => {
      const others = hiddenSectionsOf(current).filter((s) => s !== id)
      return { ...current, hiddenSections: next ? [...others, id] : others }
    })

  if (hidden && !editing) return null

  if (hidden) {
    return (
      <div id={ANCHOR[id]} className="container-main py-6 scroll-mt-20">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-dark-600 px-4 py-3">
          <p className="text-sm text-dark-400">
            <EyeOffIcon />
            <span className="text-dark-200 font-medium">{label}</span> is hidden from visitors
          </p>
          <button
            type="button"
            onClick={() => setHidden(false)}
            className="text-xs text-dark-200 hover:text-dark-50 border border-dark-600 hover:border-dark-400 rounded-lg px-3 py-1.5 transition"
          >
            Show section
          </button>
        </div>
      </div>
    )
  }

  if (!editing) return <>{children}</>

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setHidden(true)}
        title="Hide this section from visitors"
        className="absolute right-4 md:right-8 top-4 z-10 inline-flex items-center text-xs text-dark-500 hover:text-dark-50 border border-dashed border-dark-600 hover:border-dark-400 rounded-lg px-2.5 py-1.5 bg-dark-900/60 backdrop-blur transition"
      >
        <EyeOffIcon />
        Hide section
      </button>
      {children}
    </div>
  )
}

function EyeOffIcon() {
  return (
    <svg
      className="inline-block h-3.5 w-3.5 mr-1.5 -mt-0.5 align-middle"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 3l18 18" />
      <path d="M10.6 5.1A9.8 9.8 0 0 1 12 5c5 0 9 4.5 10 7-.4 1-1.2 2.3-2.4 3.6M6.5 6.6C4.4 8 2.9 10 2 12c1 2.5 5 7 10 7 1.6 0 3.1-.4 4.4-1.1" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </svg>
  )
}
