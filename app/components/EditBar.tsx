'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AnimatePresence, motion } from 'framer-motion'
import { useLang } from '../context/LanguageContext'
import { savePortfolio } from '../lib/portfolio-actions'
import TranslatePanel from './TranslatePanel'

// How long the "Saved"/"Guardado" flash stays up after a block autosaves —
// long enough to notice, short enough to not linger once it's stopped
// meaning anything.
const FLASH_MS = 1600

// Floats above the portfolio while its owner is editing. Everyone else never
// renders this, and the page they see is unchanged.
export default function EditBar({ username }: { username: string }) {
  const { editing, dirty, draft, markSaved, lastBlockSavedAt, blockSaving, uiLang, uiT } = useLang()
  const [state, setState] = useState<'idle' | 'saving' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [justSaved, setJustSaved] = useState(false)
  const [seenSavedAt, setSeenSavedAt] = useState(lastBlockSavedAt)
  const [translateOpen, setTranslateOpen] = useState(false)
  const router = useRouter()

  // Edits only live in the browser until Save actually confirms — closing the
  // tab or reloading before that discards them, same as any unsaved document.
  // This is the only guard against that; nothing here writes to the database.
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  // A field's own autosave (useBlockPersistence, 800ms after the last
  // keystroke) bumps lastBlockSavedAt — flash the button briefly to confirm
  // it, independent of dirty/Save below. Turning the flash on happens here,
  // during render (comparing against the last value seen rather than calling
  // setState directly in an effect); the effect below only ever schedules/
  // clears the timer that turns it back off, keyed on the same value so a
  // second save while still flashing restarts the timer instead of stacking.
  if (lastBlockSavedAt !== seenSavedAt) {
    setSeenSavedAt(lastBlockSavedAt)
    if (lastBlockSavedAt != null) setJustSaved(true)
  }

  useEffect(() => {
    if (lastBlockSavedAt == null) return
    const timer = setTimeout(() => setJustSaved(false), FLASH_MS)
    return () => clearTimeout(timer)
  }, [lastBlockSavedAt])

  if (!editing) return null

  async function onSave() {
    setState('saving')
    setError(null)

    const result = await savePortfolio({ content: draft })
    if (result.ok) {
      // Pass the exact snapshot that was actually sent — if the owner made
      // another edit while this request was in flight, `draft` will have
      // moved on since, and markSaved knows not to clear `dirty` for a
      // change that was never persisted. See its own comment for why.
      markSaved(draft)
      setState('idle')
      router.refresh()
    } else {
      setState('error')
      setError(result.error)
    }
  }

  return (
    <div className="fixed bottom-4 inset-x-4 z-[90] flex justify-center pointer-events-none">
      <div className="pointer-events-auto flex flex-wrap items-center gap-3 rounded-full border border-dark-600 bg-dark-900/95 backdrop-blur px-4 py-2.5 shadow-xl">
        <a
          href={`/${username}?preview=1`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-dark-300 hover:text-dark-50 transition"
        >
          Preview
        </a>

        {/* Owner-only, so its label follows `uiLang` via uiT, not the content
            language toggle — see "App language vs. content language". */}
        <button
          type="button"
          onClick={() => setTranslateOpen(true)}
          className="text-xs text-dark-300 hover:text-dark-50 transition"
        >
          {uiT.translate.open}
        </button>

        <button
          type="button"
          onClick={onSave}
          disabled={state === 'saving' || !dirty}
          className={`button-primary text-sm py-1.5 px-4 disabled:opacity-50 overflow-hidden ${
            justSaved && state !== 'saving' && !blockSaving ? 'scale-105 shadow-[0_0_0_3px_rgba(216,255,62,0.35)]' : ''
          }`}
        >
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={
                state === 'saving' || blockSaving
                  ? 'saving'
                  : justSaved
                  ? 'flash'
                  : dirty
                  ? 'save'
                  : 'saved'
              }
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.15 }}
              className="inline-flex items-center gap-1.5"
            >
              {state === 'saving' || blockSaving ? (
                <>
                  <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
                  Saving…
                </>
              ) : justSaved ? (
                uiLang === 'es' ? (
                  '¡Guardado!'
                ) : (
                  'Saved!'
                )
              ) : dirty ? (
                'Save'
              ) : (
                'Saved'
              )}
            </motion.span>
          </AnimatePresence>
        </button>

        {error && <p className="w-full text-xs text-red-400">{error}</p>}
      </div>

      <TranslatePanel open={translateOpen} onClose={() => setTranslateOpen(false)} />
    </div>
  )
}
