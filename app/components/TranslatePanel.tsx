'use client'

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { AnimatePresence, motion } from 'framer-motion'
import { useLang } from '../context/LanguageContext'
import type { Lang } from '../lib/portfolio'
import { previewTranslation, translateChunk } from '../lib/translate/translate-actions'
import { runTranslation } from '../lib/translate/run-translation'
import type { FieldFailure } from '../lib/translate/translate-batch'

/**
 * Step 5 of the AI translation feature: the owner's view of a run.
 *
 * The whole loop lives here rather than on the server, which is the point of
 * the chunked design (see translate-actions.ts): each call is one model call
 * inside one serverless function, and the client is what decides whether to ask
 * for another. That gets progress, resumability and timeout safety out of one
 * mechanism — closing this panel mid-run doesn't roll anything back, and
 * reopening it simply plans again from whatever is already translated.
 */

// Matches the action's own default. Small enough that one chunk is one quick
// model call, so the bar moves often rather than in two big jumps.
const CHUNK = 6

const LABEL: Record<Lang, string> = { es: 'ES', en: 'EN' }

type Phase = 'checking' | 'ready' | 'running' | 'done' | 'partial' | 'stopped' | 'error'

const noopSubscribe = () => () => {}

export default function TranslatePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { lang, uiT } = useLang()
  const router = useRouter()

  // Default to filling the language the owner is *not* looking at — they just
  // wrote the one on screen, so that's almost always the source.
  const [from, setFrom] = useState<Lang>(lang)
  const to: Lang = from === 'es' ? 'en' : 'es'

  const [phase, setPhase] = useState<Phase>('checking')
  const [counts, setCounts] = useState<{ missing: number; stale: number; languageNeutral: number } | null>(null)
  const [includeStale, setIncludeStale] = useState(false)
  const [done, setDone] = useState(0)
  const [total, setTotal] = useState(0)
  const [copied, setCopied] = useState(0)
  const [failures, setFailures] = useState<FieldFailure[]>([])
  const [error, setError] = useState<string | null>(null)

  // Read only inside the loop and the Stop handler, never during render.
  const stopRef = useRef(false)

  // Portal target: same useSyncExternalStore shape as OnboardingTour, so the
  // first (server) render and the hydration-matching one never touch document.
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false)

  // Bumped by "try again" to force a fresh plan without duplicating the fetch
  // into an event handler — it's just another input to the key below.
  const [reloads, setReloads] = useState(0)

  // Two render-time state transitions rather than effects. Both would be a
  // plain synchronous setState inside a `useEffect`, which is exactly what
  // this project's react-hooks/set-state-in-effect config flags (same reason
  // EditBar's `justSaved` and LanguageContext's `uiLangHydrated` are written
  // this way). Comparing an incoming value against one held in state during
  // render is the sanctioned shape.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    // Reopening follows the content language again rather than remembering a
    // flip from last time. Deliberately only on the open *transition*: the
    // owner switching content language while this panel is up must not
    // reverse the direction under their cursor mid-decision.
    if (open) setFrom(lang)
  }

  const planKey = open ? `${from}:${reloads}` : null
  const [plannedFor, setPlannedFor] = useState<string | null>(null)
  if (planKey !== plannedFor) {
    setPlannedFor(planKey)
    if (planKey) {
      setPhase('checking')
      setError(null)
      setFailures([])
      setCounts(null)
      // Also what tells the error phase apart: a preview that failed never
      // ran anything, so it has no progress to show.
      setDone(0)
      setTotal(0)
    }
  }

  // The effect only awaits and then writes state from the resolved callback —
  // asynchronous, which the rule has no objection to. The phase was already
  // moved to 'checking' during render above.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    const target: Lang = from === 'es' ? 'en' : 'es'
    previewTranslation({ from, to: target }).then((result) => {
      // Flipping direction twice quickly can land an older answer after a
      // newer one; this is what stops it overwriting the current plan.
      if (cancelled) return
      if (!result.ok) {
        setError(result.error)
        setPhase('error')
        return
      }
      setCounts({ missing: result.missing, stale: result.stale, languageNeutral: result.languageNeutral })
      setPhase('ready')
    })
    return () => {
      cancelled = true
    }
  }, [open, from, reloads])

  // `expected`/`copiedAsIs` only seed the bar until the first chunk answers
  // with the server's own figure — see runTranslation's onProgress.
  async function run(expected: number, copiedAsIs: number) {
    stopRef.current = false
    setPhase('running')
    setError(null)
    setFailures([])
    setDone(0)
    setCopied(copiedAsIs)
    setTotal(expected)

    const outcome = await runTranslation({
      chunk: (limit, skip) => translateChunk({ from, to, includeStale, limit, skip }),
      limit: CHUNK,
      shouldStop: () => stopRef.current,
      onProgress: (translated, live) => {
        setDone(translated)
        setTotal(live)
      },
    })

    if (outcome.status === 'error') setError(outcome.error)
    if (outcome.status !== 'done') setFailures(outcome.failures)
    setPhase(outcome.status)

    // Whatever landed has to become visible: the action revalidates the cache
    // server-side, but this page still holds the pre-run blocks until it
    // refetches. Done once at the end rather than per chunk — a refresh
    // mid-run would remount every field underneath the owner.
    router.refresh()
  }

  if (!open || !mounted) return null

  const c = uiT.translate
  const busy = phase === 'running'
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  const nothingToDo = phase === 'ready' && counts !== null && counts.missing === 0 && counts.stale === 0
  const canStart =
    phase === 'ready' && counts !== null && (counts.missing > 0 || (includeStale && counts.stale > 0))
  // Whether this phase is the end of a run (as opposed to a preview that
  // failed before anything ran) — only then is there progress to show.
  const ran = phase === 'running' || phase === 'done' || phase === 'partial' || phase === 'stopped' || (phase === 'error' && total > 0)
  const finished = phase === 'done' || phase === 'partial'

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/85 p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.97, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 400, damping: 30, mass: 0.6 }}
        role="dialog"
        aria-modal="true"
        aria-label={c.title}
        className="w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-2xl border border-dark-700 bg-dark-900 shadow-2xl"
      >
        <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-dark-700">
          <h2 className="text-sm font-medium text-dark-50">{c.title}</h2>
          <button
            type="button"
            aria-label={c.close}
            onClick={onClose}
            // Closing mid-run is safe and deliberately allowed: every chunk
            // that already finished is written, and reopening re-plans from
            // there. Nothing to warn about.
            className="text-dark-300 hover:text-dark-50 transition p-1.5 rounded-lg hover:bg-dark-700/60"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-5 space-y-5">
          <p className="text-xs text-dark-400 leading-relaxed">{c.intro}</p>

          <div className="space-y-2">
            <span className="block text-[11px] uppercase tracking-wider text-dark-500">{c.directionLabel}</span>
            <div className="flex gap-2">
              {(['es', 'en'] as Lang[]).map((source) => {
                const target = source === 'es' ? 'en' : 'es'
                const active = from === source
                return (
                  <button
                    key={source}
                    type="button"
                    disabled={busy}
                    onClick={() => setFrom(source)}
                    className={`text-xs font-mono rounded-full border px-3 py-1.5 transition disabled:opacity-40 ${
                      active
                        ? 'bg-dark-50 text-dark-900 border-dark-50 font-bold'
                        : 'text-dark-400 border-dark-400/40 hover:text-dark-50'
                    }`}
                  >
                    {LABEL[source]} → {LABEL[target]}
                  </button>
                )
              })}
            </div>
          </div>

          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={phase}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.15 }}
              className="space-y-3"
            >
              {phase === 'checking' && <p className="text-sm text-dark-300">{c.checking}</p>}

              {phase === 'ready' && counts !== null && (
                <>
                  {nothingToDo ? (
                    <p className="text-sm text-dark-300">{c.nothing}</p>
                  ) : (
                    <>
                      <p className="text-sm text-dark-100">{c.toFill(counts.missing)}</p>
                      {counts.stale > 0 && (
                        <div className="space-y-1.5">
                          <p className="text-sm text-dark-300">{c.outOfDate(counts.stale)}</p>
                          <p className="text-xs text-dark-500">{c.outOfDateHint}</p>
                          <label className="flex items-center gap-2 text-xs text-dark-300 cursor-pointer pt-1">
                            <input
                              type="checkbox"
                              checked={includeStale}
                              onChange={(e) => setIncludeStale(e.target.checked)}
                              className="accent-[#d8ff3e]"
                            />
                            {c.includeStale}
                          </label>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}

              {ran && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    {/* "Done" only once the run actually reached the end of
                        the plan — reported live as "Done · 0 of 124" on a run
                        that had stopped at its first batch, which read as if
                        the rest had gone through. */}
                    <span className="text-dark-300">{busy ? c.running : finished ? c.done : c.soFar}</span>
                    <span className="text-dark-400 tabular-nums">{c.progress(done, total)}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-dark-700 overflow-hidden">
                    <motion.div
                      className="h-full bg-[#d8ff3e]"
                      initial={false}
                      animate={{ width: `${pct}%` }}
                      transition={{ duration: 0.25, ease: 'easeOut' }}
                    />
                  </div>
                  {copied > 0 && <p className="text-xs text-dark-500">{c.copiedAsIs(copied)}</p>}
                </div>
              )}

              {phase === 'done' && <p className="text-xs text-dark-300 leading-relaxed">{c.doneReview}</p>}
              {phase === 'stopped' && <p className="text-xs text-dark-300">{c.stopped}</p>}

              {phase === 'error' && error && (
                <div className="space-y-1.5">
                  <p className="text-sm text-red-400 leading-relaxed">{error}</p>
                  {total > 0 && <p className="text-xs text-dark-400">{c.savedBefore(done)}</p>}
                  {done > 0 && <p className="text-xs text-dark-500">{c.continueHint}</p>}
                </div>
              )}

              {phase === 'partial' && failures.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs text-dark-300">{c.partial}</p>
                  <p className="text-xs text-dark-400">{c.someFailed(failures.length)}</p>
                  <ul className="space-y-1">
                    {failures.map((f) => (
                      <li key={f.blockKey} className="text-[11px] text-dark-500 leading-relaxed">
                        <span className="font-mono text-dark-400">{f.blockKey}</span> — {f.error}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-dark-700">
          {busy ? (
            <>
              <button
                type="button"
                // Only checked between chunks — a server action already in
                // flight can't be cancelled, and whatever it writes is saved.
                onClick={() => {
                  stopRef.current = true
                }}
                className="text-xs text-dark-300 hover:text-dark-50 transition"
              >
                {c.stop}
              </button>
              <span className="button-primary text-sm py-1.5 px-4 opacity-60 inline-flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
                {c.running}
              </span>
            </>
          ) : (
            <>
              <button type="button" onClick={onClose} className="text-xs text-dark-300 hover:text-dark-50 transition">
                {finished ? c.close : c.cancel}
              </button>
              {phase === 'partial' && failures.length > 0 && (
                // Straight into a new run: everything else from this one is
                // already written, so a fresh plan is exactly the fields that
                // failed — nothing that already went through is sent again.
                <button
                  type="button"
                  onClick={() => void run(failures.length, 0)}
                  className="button-primary text-sm py-1.5 px-4"
                >
                  {c.retryFailed(failures.length)}
                </button>
              )}
              {(phase === 'stopped' || phase === 'error') && (
                // Back through the preview rather than straight into a run, so
                // the owner sees the (now smaller) count of what's left before
                // starting — after an outright failure (not signed in, no API
                // key) there may be nothing sensible to run at all.
                <button type="button" onClick={() => setReloads((n) => n + 1)} className="button-primary text-sm py-1.5 px-4">
                  {c.tryAgain}
                </button>
              )}
              {canStart && counts !== null && (
                <button
                  type="button"
                  onClick={() =>
                    void run(counts.missing + (includeStale ? counts.stale : 0), counts.languageNeutral)
                  }
                  className="button-primary text-sm py-1.5 px-4"
                >
                  {c.start}
                </button>
              )}
            </>
          )}
        </div>
      </motion.div>
    </div>,
    document.body
  )
}
