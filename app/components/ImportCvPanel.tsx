'use client'

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, MotionConfig, motion } from 'framer-motion'
import { useLang } from '../context/LanguageContext'
import { importCv, readCv } from '../lib/cv/cv-actions'
import { uploadCvForReading } from '../lib/cv/upload-cv'
import { blockTextsFrom, planCvImport } from '../lib/cv/cv-import-plan'
import type { CvExtract } from '../lib/cv/cv-schema'
import type { HideableSection } from '../lib/portfolio'

const noopSubscribe = () => () => {}

/**
 * EditBar's "Import CV" (onboarding step 10): pick a PDF → it's read →
 * a summary of what was found and what it replaces, with the email opt-in →
 * everything is written and the page reloads with the result.
 *
 * The summary is `planCvImport` run on the page's own data — the same
 * function `importCv` runs on the database's — so the numbers the owner
 * confirms are the ones the server acts on. Owner-only tooling: its text is
 * `uiT`. The step-by-step tray that lets the owner switch cards on and off
 * comes later (step 9); this writes everything the CV has.
 */
export default function ImportCvPanel({
  open,
  onClose,
  autoPick = false,
}: {
  open: boolean
  onClose: () => void
  /** Opened from the start screen: bring the file chooser up straight away. */
  autoPick?: boolean
}) {
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false)
  if (!mounted) return null
  return createPortal(
    <MotionConfig reducedMotion="user">
      <AnimatePresence>{open && <Dialog key="import-cv" onClose={onClose} autoPick={autoPick} />}</AnimatePresence>
    </MotionConfig>,
    document.body
  )
}

type Phase =
  | { name: 'pick'; error?: string }
  | { name: 'uploading' }
  | { name: 'reading' }
  | { name: 'preview'; cv: CvExtract; keptAsCv: boolean; error?: string }
  | { name: 'importing'; cv: CvExtract; keptAsCv: boolean }

const SECTION_LABEL: Record<HideableSection, 'about' | 'projects' | 'skills' | 'contact'> = {
  journey: 'about',
  projects: 'projects',
  skills: 'skills',
  contact: 'contact',
}

function Dialog({ onClose, autoPick }: { onClose: () => void; autoPick: boolean }) {
  const { uiT, dirty } = useLang()
  const c = uiT.importCv
  const [phase, setPhase] = useState<Phase>({ name: 'pick' })
  const [includeEmail, setIncludeEmail] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const busy = phase.name === 'uploading' || phase.name === 'reading' || phase.name === 'importing'

  // Still inside the click that chose "With my CV", so the browser lets the
  // chooser open without another click (where it doesn't, the button is there).
  useEffect(() => {
    if (autoPick && !dirty) input.current?.click()
    // Once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  async function onFile(file: File | undefined) {
    if (input.current) input.current.value = ''
    if (!file) return
    setPhase({ name: 'uploading' })
    const uploaded = await uploadCvForReading(file, 'import')
    if (!uploaded.ok) return setPhase({ name: 'pick', error: c.errors[uploaded.error] ?? c.errors.failed })
    setPhase({ name: 'reading' })
    const result = await readCv(uploaded.path)
    if (!result.ok) {
      const message = result.error === 'failed' && 'message' in result && result.message ? result.message : null
      return setPhase({ name: 'pick', error: message ?? c.errors[result.error] ?? c.errors.failed })
    }
    setIncludeEmail(false)
    setPhase({ name: 'preview', cv: result.cv, keptAsCv: !!result.keptAsCv })
  }

  async function onImport() {
    if (phase.name !== 'preview') return
    setPhase({ name: 'importing', cv: phase.cv, keptAsCv: phase.keptAsCv })
    const result = await importCv(phase.cv, { includeEmail })
    if (result.ok) {
      // A full load: the structure (projects, chapters, categories) changed
      // underneath the page's draft, and every editor seeds itself once.
      window.location.reload()
      return
    }
    const message = result.error === 'failed' && 'message' in result && result.message ? result.message : null
    setPhase({ name: 'preview', cv: phase.cv, keptAsCv: phase.keptAsCv, error: message ?? c.errors[result.error] ?? c.errors.failed })
  }

  return (
    <motion.div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={() => !busy && onClose()}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-cv-title"
        className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-2xl border border-dark-700 bg-dark-900 p-5 md:p-6 shadow-2xl"
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.98 }}
        transition={{ type: 'spring', stiffness: 380, damping: 32 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id="import-cv-title" className="text-lg font-semibold text-dark-50">
            {c.title}
          </h2>
          {!busy && (
            <button
              type="button"
              onClick={onClose}
              aria-label={c.cancel}
              className="-mr-1.5 -mt-1 p-1.5 rounded-lg text-dark-300 hover:text-dark-50 hover:bg-dark-700/60 transition"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>

        <input
          ref={input}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={(e) => void onFile(e.target.files?.[0])}
        />

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={phase.name === 'importing' ? 'preview' : phase.name === 'uploading' ? 'reading' : phase.name}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18 }}
          >
            {phase.name === 'pick' && (
              <div className="mt-2">
                <p className="text-sm leading-relaxed text-dark-300">{c.intro}</p>
                <p className="mt-2 text-xs text-dark-500">{c.linkedinTip}</p>
                {phase.error && <p className="mt-4 text-sm text-red-400">{phase.error}</p>}
                {dirty && <p className="mt-4 text-sm text-amber-200/90">{c.unsaved}</p>}
                <div className="mt-5 flex items-center justify-end gap-3">
                  <button type="button" onClick={onClose} className="text-sm text-dark-400 hover:text-dark-50 transition">
                    {c.cancel}
                  </button>
                  <button
                    type="button"
                    disabled={dirty}
                    onClick={() => input.current?.click()}
                    className="rounded-full bg-[#d8ff3e] px-5 py-2 text-sm font-semibold text-[#08080a] transition hover:brightness-110 disabled:opacity-40"
                  >
                    {phase.error ? c.another : c.choose}
                  </button>
                </div>
              </div>
            )}

            {(phase.name === 'uploading' || phase.name === 'reading') && (
              <Reading label={phase.name === 'uploading' ? c.uploading : c.reading} steps={c.readingSteps} note={c.readingNote} active={phase.name === 'reading'} />
            )}

            {(phase.name === 'preview' || phase.name === 'importing') && (
              <Preview
                cv={phase.cv}
                keptAsCv={phase.keptAsCv}
                importing={phase.name === 'importing'}
                error={phase.name === 'preview' ? phase.error : undefined}
                includeEmail={includeEmail}
                setIncludeEmail={setIncludeEmail}
                onImport={() => void onImport()}
                onAnother={() => input.current?.click()}
                onClose={onClose}
              />
            )}
          </motion.div>
        </AnimatePresence>
      </motion.div>
    </motion.div>
  )
}

/** The reading state: a page being scanned, and the step lines taking turns. */
function Reading({ label, steps, note, active }: { label: string; steps: string[]; note: string; active: boolean }) {
  const [step, setStep] = useState(0)
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setStep((s) => (s + 1) % steps.length), 2600)
    return () => clearInterval(timer)
  }, [active, steps.length])

  return (
    <div className="flex flex-col items-center py-8 text-center" aria-live="polite">
      <div className="relative h-24 w-[4.5rem] overflow-hidden rounded-lg border border-dark-600 bg-dark-800">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            className="mx-2.5 mt-2.5 h-1.5 rounded-full bg-dark-600"
            style={{ width: `${[70, 45, 80, 60, 75, 40][i]}%` }}
          />
        ))}
        <motion.div
          className="absolute inset-x-0 h-8 bg-gradient-to-b from-transparent via-[#d8ff3e]/25 to-transparent"
          initial={{ y: -32 }}
          animate={{ y: 96 }}
          transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut', repeatType: 'reverse' }}
        />
      </div>
      <p className="mt-5 text-sm font-medium text-dark-50">{label}</p>
      <div className="mt-1 h-5 overflow-hidden">
        {active && (
          <AnimatePresence mode="wait">
            <motion.p
              key={step}
              className="text-xs text-dark-400"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.25 }}
            >
              {steps[step]}…
            </motion.p>
          </AnimatePresence>
        )}
      </div>
      <p className="mt-4 text-[11px] text-dark-500">{note}</p>
    </div>
  )
}

function Preview({
  cv,
  keptAsCv,
  importing,
  error,
  includeEmail,
  setIncludeEmail,
  onImport,
  onAnother,
  onClose,
}: {
  cv: CvExtract
  keptAsCv: boolean
  importing: boolean
  error?: string
  includeEmail: boolean
  setIncludeEmail: (v: boolean) => void
  onImport: () => void
  onAnother: () => void
  onClose: () => void
}) {
  const { uiT, uiLang, draft, blocks, media } = useLang()
  const c = uiT.importCv
  const summary = useMemo(
    () =>
      planCvImport({
        cv,
        content: draft,
        texts: blockTextsFrom(blocks),
        media,
        includeEmail,
        stamp: 'preview',
      }).summary,
    [cv, draft, blocks, media, includeEmail]
  )

  const found = [
    summary.added.jobs && c.jobs(summary.added.jobs),
    summary.added.education && c.education(summary.added.education),
    summary.added.skillGroups && c.skillGroups(summary.added.skillGroups),
    summary.added.certifications && c.certifications(summary.added.certifications),
    summary.added.links && c.links(summary.added.links),
  ].filter((x): x is string => !!x)

  const r = summary.replaced
  const replaced = [
    r.projects && c.replaced.projects(r.projects),
    r.chapters && c.replaced.chapters(r.chapters),
    r.skillGroups && c.replaced.skillGroups(r.skillGroups),
    r.certifications && c.replaced.certifications(r.certifications),
  ].filter((x): x is string => !!x)

  const hiddenNames = summary.hidden.map((s) => uiT.nav[SECTION_LABEL[s]]).join(uiLang === 'es' ? ' ni ' : ' or ')

  return (
    <div className="mt-4">
      <div className="rounded-xl border border-dark-700 bg-dark-800/50 px-4 py-3">
        {cv.name && <p className="text-base font-semibold text-dark-50">{cv.name}</p>}
        {cv.headline && <p className="text-sm text-dark-300">{cv.headline}</p>}
        <p className="mt-3 text-[11px] uppercase tracking-wider text-dark-500">{c.found}</p>
        <ul className="mt-1.5 space-y-1">
          {found.map((line, i) => (
            <motion.li
              key={line}
              className="flex items-center gap-2 text-sm text-dark-100"
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.06 * i }}
            >
              <span className="text-[#d8ff3e]" aria-hidden>
                ✓
              </span>
              {line}
            </motion.li>
          ))}
        </ul>
      </div>

      {replaced.length > 0 ? (
        <div className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2 text-xs leading-relaxed text-amber-100/90">
          <p>{c.replaces}</p>
          <p className="mt-0.5 font-medium">
            {replaced.join(' · ')}
            {r.photos > 0 && ` ${c.replaced.photos(r.photos)}`}
          </p>
        </div>
      ) : (
        <p className="mt-3 text-xs text-dark-400">{c.starterNote}</p>
      )}

      {summary.hidden.length > 0 && <p className="mt-2 text-xs text-dark-400">{c.hides(hiddenNames)}</p>}

      {cv.contact.email && (
        <label className="mt-4 flex cursor-pointer items-center gap-2.5 text-sm text-dark-200">
          <input
            type="checkbox"
            checked={includeEmail}
            onChange={(e) => setIncludeEmail(e.target.checked)}
            disabled={importing}
            className="h-4 w-4 accent-[#d8ff3e]"
          />
          <span className="min-w-0 break-words">{c.showEmail(cv.contact.email)}</span>
        </label>
      )}

      <p className="mt-4 text-xs text-dark-500">{c.writtenIn(uiT.translate.langName[cv.language])}</p>
      {keptAsCv && <p className="mt-1 text-xs text-dark-500">{c.keptAsCv}</p>}

      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

      <div className="mt-5 flex flex-wrap items-center justify-end gap-3">
        {!importing && (
          <>
            <button type="button" onClick={onAnother} className="mr-auto text-xs text-dark-400 hover:text-dark-50 transition">
              {c.another}
            </button>
            <button type="button" onClick={onClose} className="text-sm text-dark-400 hover:text-dark-50 transition">
              {c.cancel}
            </button>
          </>
        )}
        <button
          type="button"
          onClick={onImport}
          disabled={importing}
          className="inline-flex items-center gap-2 rounded-full bg-[#d8ff3e] px-5 py-2 text-sm font-semibold text-[#08080a] transition hover:brightness-110 disabled:opacity-70"
        >
          {importing && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
          {importing ? c.importing : c.import}
        </button>
      </div>
    </div>
  )
}
