'use client'

import { useEffect, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, MotionConfig, motion } from 'framer-motion'
import { useLang } from '../context/LanguageContext'
import { plainTextFromDoc } from '../lib/editor/render-html'

const noopSubscribe = () => () => {}

/**
 * "How do you want to start?" — onboarding step 7. A new owner's first real
 * decision: draft the portfolio from their CV, or fill in the example by hand.
 *
 * Shown by the server (app/[username]/page.tsx) after the address is chosen
 * and before the tour, only while the portfolio is untouched
 * (`isUntouchedPortfolio`) and the owner hasn't answered on this device (a
 * cookie, set here). The tour is held back while it's up (`holdTour`), and
 * starts as soon as it closes — or, after "With my CV", as soon as the import
 * panel closes without importing (an import reloads the page anyway).
 */
export default function StartScreen({
  open,
  cookie,
  onChooseCv,
  onChooseScratch,
}: {
  open: boolean
  cookie: string
  onChooseCv: () => void
  onChooseScratch: () => void
}) {
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false)
  if (!mounted) return null

  const choose = (choice: 'cv' | 'scratch') => {
    // A year: the answer only matters while the portfolio is still untouched.
    document.cookie = `${cookie}=${choice}; path=/; max-age=31536000; samesite=lax`
    if (choice === 'cv') onChooseCv()
    else onChooseScratch()
  }

  return createPortal(
    <MotionConfig reducedMotion="user">
      <AnimatePresence>{open && <Screen key="start" onChoose={choose} />}</AnimatePresence>
    </MotionConfig>,
    document.body
  )
}

const item = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { type: 'spring' as const, stiffness: 300, damping: 30 } },
}

function Screen({ onChoose }: { onChoose: (choice: 'cv' | 'scratch') => void }) {
  const { uiT, blocks, lang } = useLang()
  const c = uiT.start
  const name = plainTextFromDoc(blocks['hero.name']?.[lang]?.json ?? blocks['hero.name']?.en?.json).split(' ')[0] ?? ''

  // Escape answers "from scratch": the owner closed it, and the page behind it
  // is the example they'd be editing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onChoose('scratch')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onChoose])

  return (
    <motion.div
      className="fixed inset-0 z-[115] overflow-y-auto bg-dark-900/95 backdrop-blur-md"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.25 } }}
    >
      {/* A faint lime glow, the brand's one accent, behind the choice. */}
      <div
        aria-hidden
        className="pointer-events-none fixed left-1/2 top-1/3 h-[420px] w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#d8ff3e]/[0.06] blur-3xl"
      />
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="start-title"
        className="relative mx-auto flex min-h-full max-w-3xl flex-col justify-center px-4 py-12 sm:px-6"
        initial="hidden"
        animate="show"
        variants={{ show: { transition: { staggerChildren: 0.08, delayChildren: 0.1 } } }}
      >
        <motion.p variants={item} className="font-mono text-xs uppercase tracking-[0.2em] text-[#d8ff3e]">
          {c.kicker(name)}
        </motion.p>
        <motion.h1 variants={item} id="start-title" className="mt-3 text-3xl font-bold text-dark-50 sm:text-5xl">
          {c.title}
        </motion.h1>
        <motion.p variants={item} className="mt-3 max-w-xl text-sm text-dark-300 sm:text-base">
          {c.intro}
        </motion.p>

        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          <motion.button
            variants={item}
            type="button"
            onClick={() => onChoose('cv')}
            whileHover={{ y: -3 }}
            whileTap={{ scale: 0.98 }}
            className="group relative flex flex-col rounded-2xl border border-[#d8ff3e]/50 bg-dark-800/70 p-5 text-left shadow-[0_0_0_1px_rgba(216,255,62,0.08),0_20px_60px_-20px_rgba(216,255,62,0.25)] transition-colors hover:border-[#d8ff3e] sm:p-6"
          >
            <span className="absolute right-4 top-4 rounded-full bg-[#d8ff3e] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[#08080a]">
              {c.recommended}
            </span>
            <CvIcon />
            <span className="mt-4 text-lg font-semibold text-dark-50">{c.cvTitle}</span>
            <span className="mt-1.5 text-sm leading-relaxed text-dark-300">{c.cvBody}</span>
            <span className="mt-4 text-xs text-dark-500">{c.cvDetail}</span>
          </motion.button>

          <motion.button
            variants={item}
            type="button"
            onClick={() => onChoose('scratch')}
            whileHover={{ y: -3 }}
            whileTap={{ scale: 0.98 }}
            className="flex flex-col rounded-2xl border border-dark-600 bg-dark-800/40 p-5 text-left transition-colors hover:border-dark-400 sm:p-6"
          >
            <PenIcon />
            <span className="mt-4 text-lg font-semibold text-dark-50">{c.scratchTitle}</span>
            <span className="mt-1.5 text-sm leading-relaxed text-dark-300">{c.scratchBody}</span>
            <span className="mt-4 text-xs text-dark-500">{c.scratchDetail}</span>
          </motion.button>
        </div>

        <motion.p variants={item} className="mt-6 text-xs text-dark-500">
          {c.later}
        </motion.p>
      </motion.div>
    </motion.div>
  )
}

function CvIcon() {
  return (
    <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#d8ff3e]/10 text-[#d8ff3e]">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M14 3v5h5M9 13h6M9 17h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    </span>
  )
}

function PenIcon() {
  return (
    <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-dark-700/60 text-dark-200">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="m13.5 6.5 4 4" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    </span>
  )
}
