'use client'

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import {
  AnimatePresence,
  MotionConfig,
  animate,
  motion,
  useMotionValue,
  useTransform,
} from 'framer-motion'
import { useLang } from '../context/LanguageContext'
import type { Lang } from '../lib/portfolio'
import { previewTranslation, translateChunk } from '../lib/translate/translate-actions'
import { runTranslation } from '../lib/translate/run-translation'
import type { ChunkFailure, TranslatedItem } from '../lib/translate/translate-batch'

/**
 * Step 5 of the AI translation feature: the owner's view of a run.
 *
 * The whole loop lives here rather than on the server, which is the point of
 * the chunked design (see translate-actions.ts): each call is one model call
 * inside one serverless function, and the client is what decides whether to ask
 * for another. That gets progress, resumability and timeout safety out of one
 * mechanism — closing this panel mid-run doesn't roll anything back, and
 * reopening it simply plans again from whatever is already translated.
 *
 * Redesigned after "terminó y no sé qué hizo": the first version ended on a
 * progress bar and a count, which says nothing about *what* changed. Now every
 * chunk hands back readable before/after text (`written`), shown as a live feed
 * while it runs and, at the end, grouped by page section — each one expandable
 * down to the actual lines — plus a button that switches the page to the
 * language that was just filled.
 */

// Matches the action's own default. Small enough that one chunk is one quick
// model call, so the counter moves often rather than in two big jumps.
const CHUNK = 6

const LABEL: Record<Lang, string> = { es: 'ES', en: 'EN' }

// Page order, so the summary reads top to bottom like the portfolio does.
const SECTION_ORDER = ['hero', 'journey', 'projects', 'skills', 'contact', 'footer']

const EASE = [0.22, 1, 0.36, 1] as const

type Phase =
  | 'checking'
  | 'ready'
  | 'running'
  | 'done'
  | 'partial'
  | 'stopped'
  /** A run that ended on an error, with whatever it saved before that. */
  | 'failed'
  /** The preview itself failed — nothing ran. */
  | 'error'

const noopSubscribe = () => () => {}

export default function TranslatePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { lang, uiT, toggleLang } = useLang()
  const router = useRouter()
  // Tracks the end-of-run refresh until its render has committed, so "View in
  // …" can't switch language onto blocks that haven't arrived yet: the editors
  // it remounts are seeded once, from whatever the context holds at that moment.
  const [refreshing, startRefresh] = useTransition()

  // Default to filling the language the owner is *not* looking at — they just
  // wrote the one on screen, so that's almost always the source.
  const [from, setFrom] = useState<Lang>(lang)
  const to: Lang = from === 'es' ? 'en' : 'es'

  const [phase, setPhase] = useState<Phase>('checking')
  const [counts, setCounts] = useState<{ missing: number; stale: number } | null>(null)
  const [includeStale, setIncludeStale] = useState(false)
  const [done, setDone] = useState(0)
  const [total, setTotal] = useState(0)
  const [items, setItems] = useState<TranslatedItem[]>([])
  const [failures, setFailures] = useState<ChunkFailure[]>([])
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
    if (open) {
      setFrom(lang)
      setItems([])
    }
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
      setCounts({ missing: result.missing, stale: result.stale })
      setPhase('ready')
    })
    return () => {
      cancelled = true
    }
  }, [open, from, reloads])

  // Escape closes, same as ×. Safe at any point — see the × button.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  /**
   * `keep` carries the items of the run before (a retry of what failed), so
   * the summary still describes everything this panel translated rather than
   * only the last handful.
   */
  async function run(expected: number, keep: boolean) {
    stopRef.current = false
    setPhase('running')
    setError(null)
    setFailures([])
    setDone(0)
    setTotal(expected)
    if (!keep) setItems([])

    const outcome = await runTranslation({
      chunk: (limit, skip) => translateChunk({ from, to, includeStale, limit, skip }),
      limit: CHUNK,
      shouldStop: () => stopRef.current,
      onProgress: (translated, live) => {
        setDone(translated)
        setTotal(live)
      },
      onChunk: (result) => {
        if (result.written.length > 0) setItems((prev) => [...prev, ...result.written])
      },
    })

    if (outcome.status === 'error') setError(outcome.error)
    if (outcome.status !== 'done') setFailures(outcome.failures)
    setPhase(outcome.status === 'error' ? 'failed' : outcome.status)

    // Whatever landed has to become visible: the action revalidates the cache
    // server-side, but this page still holds the pre-run blocks until it
    // refetches. Done once at the end rather than per chunk — a refresh
    // mid-run would remount every field underneath the owner.
    startRefresh(() => router.refresh())
  }

  const c = uiT.translate
  const planned = counts ? counts.missing + (includeStale ? counts.stale : 0) : 0
  const nothingToDo = phase === 'ready' && counts !== null && counts.missing === 0 && counts.stale === 0
  const canStart = phase === 'ready' && planned > 0
  const isSummary = phase === 'done' || phase === 'partial' || phase === 'stopped' || phase === 'failed'
  const bodyKey = isSummary ? 'summary' : phase

  if (!mounted) return null

  return createPortal(
    // reducedMotion="user": under prefers-reduced-motion, every transform
    // animation in here (slides, scale, the sheen) is dropped and only the
    // fades remain.
    <MotionConfig reducedMotion="user">
      <AnimatePresence>
        {open && (
          <motion.div
            key="translate-panel"
            className="fixed inset-0 z-[120] flex items-center justify-center p-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} aria-hidden />
            <motion.div
              initial={{ opacity: 0, y: 16, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
              transition={{ type: 'spring', stiffness: 380, damping: 32, mass: 0.7 }}
              role="dialog"
              aria-modal="true"
              aria-label={c.title}
              className="relative w-full max-w-md max-h-[85vh] overflow-y-auto rounded-2xl border border-dark-700/80 bg-dark-900 shadow-2xl"
            >
              <div className="flex items-center justify-between gap-4 px-5 pt-5">
                <div className="flex items-center gap-2.5">
                  <h2 className="text-sm font-medium text-dark-50">{c.title}</h2>
                  {phase !== 'checking' && phase !== 'ready' && phase !== 'error' && (
                    <motion.span
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="text-[10px] font-mono text-dark-500 rounded-full border border-dark-700 px-2 py-0.5"
                    >
                      {LABEL[from]} → {LABEL[to]}
                    </motion.span>
                  )}
                </div>
                <button
                  type="button"
                  aria-label={c.close}
                  onClick={onClose}
                  // Closing mid-run is safe and deliberately allowed: every chunk
                  // that already finished is written, and reopening re-plans from
                  // there. Nothing to warn about.
                  className="text-dark-400 hover:text-dark-50 transition p-1.5 -mr-1.5 rounded-lg hover:bg-dark-800"
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                  </svg>
                </button>
              </div>

              <AutoHeight>
                <div className="px-5 pt-5 pb-2">
                  <AnimatePresence initial={false}>
                    {(phase === 'checking' || phase === 'ready') && (
                      <motion.div
                        key="direction"
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.25, ease: EASE }}
                        className="overflow-hidden"
                      >
                        <DirectionSwitch from={from} onChange={setFrom} />
                      </motion.div>
                    )}
                  </AnimatePresence>

                  <AnimatePresence mode="wait" initial={false}>
                    <motion.div
                      key={bodyKey}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -6 }}
                      transition={{ duration: 0.2, ease: EASE }}
                      className="pt-5 pb-3"
                    >
                      {phase === 'checking' && (
                        <div className="space-y-3" aria-live="polite">
                          <div className="h-11 w-20 rounded-lg bg-dark-800 animate-pulse" />
                          <p className="text-sm text-dark-500">{c.checking}</p>
                        </div>
                      )}

                      {phase === 'ready' && counts !== null && nothingToDo && (
                        <div className="flex items-center gap-3">
                          <CheckMark />
                          <p className="text-sm text-dark-200">{c.nothing}</p>
                        </div>
                      )}

                      {phase === 'ready' && counts !== null && !nothingToDo && (
                        <div className="space-y-4">
                          <div>
                            <div className="text-5xl font-semibold tracking-tight text-dark-50 tabular-nums">
                              <Counter value={planned} />
                            </div>
                            <p className="mt-1 text-sm text-dark-400">{c.toTranslate(c.langName[to])}</p>
                          </div>
                          {counts.stale > 0 && (
                            <label className="flex items-start gap-3 cursor-pointer rounded-xl border border-dark-700/70 px-3.5 py-3 hover:border-dark-600 transition">
                              <input
                                type="checkbox"
                                checked={includeStale}
                                onChange={(e) => setIncludeStale(e.target.checked)}
                                className="mt-0.5 accent-[#d8ff3e]"
                              />
                              <span className="space-y-0.5">
                                <span className="block text-sm text-dark-100">{c.includeStale}</span>
                                <span className="block text-xs text-dark-500 leading-relaxed">
                                  {c.outOfDate(counts.stale)}
                                </span>
                              </span>
                            </label>
                          )}
                        </div>
                      )}

                      {phase === 'running' && (
                        <div className="space-y-5" aria-live="polite">
                          <div>
                            <div className="flex items-baseline gap-2">
                              <span className="text-5xl font-semibold tracking-tight text-dark-50 tabular-nums">
                                <Counter value={done} />
                              </span>
                              <span className="text-sm text-dark-500 tabular-nums">
                                {c.of} {total}
                              </span>
                            </div>
                            <p className="mt-1 text-sm text-dark-400">
                              {c.running}
                              <Dots />
                            </p>
                          </div>
                          <ProgressBar value={total > 0 ? done / total : 0} />
                          <LiveFeed items={items} />
                        </div>
                      )}

                      {isSummary && (
                        <Summary
                          phase={phase}
                          items={items}
                          failures={failures}
                          error={error}
                          doneThisRun={done}
                          onRetryFailed={() => void run(failures.length, true)}
                        />
                      )}

                      {phase === 'error' && error && (
                        <div className="flex items-start gap-3">
                          <AlertMark />
                          <p className="text-sm text-dark-200 leading-relaxed pt-2">{error}</p>
                        </div>
                      )}
                    </motion.div>
                  </AnimatePresence>
                </div>
              </AutoHeight>

              <div className="flex items-center justify-end gap-2 px-5 pb-5 pt-1">
                {phase === 'running' ? (
                  <FooterButton
                    onClick={() => {
                      // Only checked between chunks — a server action already
                      // in flight can't be cancelled, and whatever it writes
                      // is saved.
                      stopRef.current = true
                    }}
                  >
                    {c.stop}
                  </FooterButton>
                ) : (
                  <>
                    <FooterButton onClick={onClose}>
                      {isSummary || nothingToDo ? c.close : c.cancel}
                    </FooterButton>
                    {(phase === 'stopped' || phase === 'failed' || phase === 'error') && (
                      // Back through the preview rather than straight into a
                      // run, so the owner sees the (now smaller) count of
                      // what's left before starting.
                      <PrimaryButton onClick={() => setReloads((n) => n + 1)}>{c.tryAgain}</PrimaryButton>
                    )}
                    {(phase === 'done' || phase === 'partial') && items.length > 0 && lang !== to && (
                      <PrimaryButton
                        disabled={refreshing}
                        onClick={() => {
                          toggleLang()
                          onClose()
                        }}
                      >
                        {refreshing ? c.updating : c.view(c.langName[to])}
                      </PrimaryButton>
                    )}
                    {canStart && <PrimaryButton onClick={() => void run(planned, false)}>{c.start}</PrimaryButton>}
                  </>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </MotionConfig>,
    document.body
  )
}

/* ------------------------------------------------------------------------ */

function Summary({
  phase,
  items,
  failures,
  error,
  doneThisRun,
  onRetryFailed,
}: {
  phase: Phase
  items: TranslatedItem[]
  failures: ChunkFailure[]
  error: string | null
  doneThisRun: number
  onRetryFailed: () => void
}) {
  const { uiT } = useLang()
  const c = uiT.translate
  const [openSection, setOpenSection] = useState<string | null>(null)
  const [showFailed, setShowFailed] = useState(false)

  const groups = groupBySection(items)
  // The common case is one error for every failed field (the service was
  // overloaded) — said once above the list, not repeated on every line.
  const sharedError =
    failures.length > 0 && failures.every((f) => f.error === failures[0].error) ? failures[0].error : null

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3.5">
        {phase === 'failed' ? <AlertMark /> : phase === 'stopped' ? <PauseMark /> : <CheckMark />}
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-4xl font-semibold tracking-tight text-dark-50 tabular-nums leading-none">
              <Counter value={items.length} />
            </span>
            <span className="text-sm text-dark-400">{c.fieldsTranslated(items.length)}</span>
          </div>
          {phase === 'failed' && (
            <p className="mt-2 text-sm text-dark-200 leading-relaxed">
              <span className="text-dark-50 font-medium">{c.failedTitle}.</span> {error}
            </p>
          )}
          {phase === 'failed' && doneThisRun > 0 && <p className="mt-1 text-xs text-dark-500">{c.continueHint}</p>}
          {phase === 'stopped' && <p className="mt-2 text-xs text-dark-400">{c.stopped}</p>}
          {(phase === 'done' || phase === 'partial') && (
            <p className="mt-2 text-xs text-dark-500 leading-relaxed">{c.review}</p>
          )}
        </div>
      </div>

      {groups.length > 0 && (
        <ul className="rounded-xl border border-dark-700/70 divide-y divide-dark-800 overflow-hidden">
          {groups.map(([section, list], i) => {
            const isOpen = openSection === section
            return (
              <motion.li
                key={section}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.15 + i * 0.05, duration: 0.25, ease: EASE }}
              >
                <button
                  type="button"
                  onClick={() => setOpenSection(isOpen ? null : section)}
                  aria-expanded={isOpen}
                  className="w-full flex items-center justify-between gap-3 px-3.5 py-2.5 text-left hover:bg-dark-800/60 transition"
                >
                  <span className="text-sm text-dark-100">{c.sections[section] ?? section}</span>
                  <span className="flex items-center gap-2 text-xs text-dark-500 tabular-nums">
                    {list.length}
                    <Chevron open={isOpen} />
                  </span>
                </button>
                <Collapse open={isOpen}>
                  <ul className="px-3.5 pb-3 space-y-2.5 max-h-60 overflow-y-auto">
                    {list.map((item) => (
                      <li key={item.blockKey} className="space-y-0.5">
                        <p className="text-[11px] text-dark-500 line-clamp-2">{item.source}</p>
                        <p className="text-xs text-dark-100 line-clamp-2">{item.result}</p>
                      </li>
                    ))}
                  </ul>
                </Collapse>
              </motion.li>
            )
          })}
        </ul>
      )}

      {phase === 'partial' && failures.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 + groups.length * 0.05, duration: 0.25, ease: EASE }}
          className="rounded-xl border border-amber-500/25 bg-amber-500/[0.04]"
        >
          <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
            <button
              type="button"
              onClick={() => setShowFailed((v) => !v)}
              aria-expanded={showFailed}
              className="flex items-center gap-2 text-sm text-amber-200/90 hover:text-amber-100 transition text-left"
            >
              {c.didntGoThrough(failures.length)}
              <Chevron open={showFailed} />
            </button>
            <button
              type="button"
              onClick={onRetryFailed}
              className="shrink-0 text-xs font-medium text-dark-50 rounded-full border border-dark-600 px-3 py-1 hover:bg-dark-800 transition"
            >
              {c.retryFailed(failures.length)}
            </button>
          </div>
          <Collapse open={showFailed}>
            <div className="px-3.5 pb-3 space-y-2">
              {sharedError && <p className="text-[11px] text-amber-200/70">{sharedError}</p>}
              <ul className="space-y-1.5 max-h-48 overflow-y-auto">
                {failures.map((f) => (
                  <li key={f.blockKey} className="text-xs text-dark-300">
                    <span className="line-clamp-1">
                      <span className="text-dark-500">
                        {f.section ? `${c.sections[f.section] ?? f.section} · ` : ''}
                      </span>
                      {f.source || f.blockKey}
                    </span>
                    {!sharedError && <span className="block text-[11px] text-amber-200/70">{f.error}</span>}
                  </li>
                ))}
              </ul>
            </div>
          </Collapse>
        </motion.div>
      )}
    </div>
  )
}

function groupBySection(items: TranslatedItem[]): [string, TranslatedItem[]][] {
  const map = new Map<string, TranslatedItem[]>()
  for (const item of items) {
    const list = map.get(item.section)
    if (list) list.push(item)
    else map.set(item.section, [item])
  }
  const rank = (s: string) => {
    const i = SECTION_ORDER.indexOf(s)
    return i === -1 ? SECTION_ORDER.length : i
  }
  return [...map.entries()].sort((a, b) => rank(a[0]) - rank(b[0]))
}

/** The last few fields that landed, newest on top — what "translating" is doing right now. */
function LiveFeed({ items }: { items: TranslatedItem[] }) {
  const recent = items.slice(-3).reverse()
  return (
    <ul className="space-y-3 min-h-[7.5rem]">
      <AnimatePresence initial={false} mode="popLayout">
        {recent.map((item, i) => (
          <motion.li
            key={item.blockKey}
            layout
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1 - i * 0.3, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3, ease: EASE }}
            className="space-y-0.5"
          >
            <p className="text-[11px] text-dark-500 truncate">{item.source}</p>
            <p className="text-sm text-dark-100 truncate">{item.result}</p>
          </motion.li>
        ))}
      </AnimatePresence>
    </ul>
  )
}

function DirectionSwitch({ from, onChange }: { from: Lang; onChange: (lang: Lang) => void }) {
  return (
    <div className="inline-flex rounded-full border border-dark-700 p-0.5">
      {(['es', 'en'] as Lang[]).map((source) => {
        const active = from === source
        return (
          <button
            key={source}
            type="button"
            onClick={() => onChange(source)}
            aria-pressed={active}
            className={`relative text-xs font-mono px-3.5 py-1.5 rounded-full transition-colors ${
              active ? 'text-dark-900 font-bold' : 'text-dark-400 hover:text-dark-100'
            }`}
          >
            {active && (
              <motion.span
                layoutId="translate-direction"
                className="absolute inset-0 rounded-full bg-dark-50"
                transition={{ type: 'spring', stiffness: 500, damping: 38 }}
              />
            )}
            <span className="relative">
              {LABEL[source]} → {LABEL[source === 'es' ? 'en' : 'es']}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function ProgressBar({ value }: { value: number }) {
  return (
    <div className="relative h-1 rounded-full bg-dark-800 overflow-hidden">
      <motion.div
        className="absolute inset-y-0 left-0 rounded-full bg-[#d8ff3e]"
        initial={false}
        animate={{ width: `${Math.round(Math.min(1, value) * 100)}%` }}
        transition={{ duration: 0.5, ease: EASE }}
      />
      {/* A sheen that keeps moving while a chunk is in flight — a model call
          is several seconds of nothing visibly changing otherwise. */}
      <motion.div
        className="absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/25 to-transparent"
        animate={{ x: ['-100%', '300%'] }}
        transition={{ repeat: Infinity, duration: 1.6, ease: 'easeInOut' }}
      />
    </div>
  )
}

/** Counts up to `value` (from 0 on mount), so a new figure never just snaps in. */
function Counter({ value }: { value: number }) {
  const mv = useMotionValue(0)
  const rounded = useTransform(mv, (v) => Math.round(v))
  useEffect(() => {
    const controls = animate(mv, value, { duration: 0.6, ease: EASE })
    return () => controls.stop()
  }, [mv, value])
  return <motion.span>{rounded}</motion.span>
}

function Dots() {
  return (
    <span aria-hidden className="inline-flex w-4">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          animate={{ opacity: [0.2, 1, 0.2] }}
          transition={{ repeat: Infinity, duration: 1.2, delay: i * 0.2 }}
        >
          .
        </motion.span>
      ))}
    </span>
  )
}

function CheckMark() {
  return (
    <motion.span
      initial={{ scale: 0.6, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 420, damping: 22 }}
      className="shrink-0 grid place-items-center w-9 h-9 rounded-full bg-[#d8ff3e]/10 text-[#d8ff3e]"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
        <motion.path
          d="M5 12.5l4.5 4.5L19 7.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ delay: 0.15, duration: 0.4, ease: EASE }}
        />
      </svg>
    </motion.span>
  )
}

function AlertMark() {
  return (
    <motion.span
      initial={{ scale: 0.6, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 420, damping: 22 }}
      className="shrink-0 grid place-items-center w-9 h-9 rounded-full bg-amber-500/10 text-amber-300"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
        <path d="M12 7v6M12 17h.01" strokeLinecap="round" />
      </svg>
    </motion.span>
  )
}

function PauseMark() {
  return (
    <motion.span
      initial={{ scale: 0.6, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 420, damping: 22 }}
      className="shrink-0 grid place-items-center w-9 h-9 rounded-full bg-dark-800 text-dark-300"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <rect x="6" y="5" width="4" height="14" rx="1" />
        <rect x="14" y="5" width="4" height="14" rx="1" />
      </svg>
    </motion.span>
  )
}

function Chevron({ open }: { open: boolean }) {
  return (
    <motion.svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      animate={{ rotate: open ? 180 : 0 }}
      transition={{ duration: 0.2, ease: EASE }}
    >
      <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
    </motion.svg>
  )
}

function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.25, ease: EASE }}
          className="overflow-hidden"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/**
 * Animates the panel's height between phases instead of letting it snap. The
 * height is measured with a ResizeObserver and only written from its callback
 * (asynchronous, so no set-state-in-effect), rather than framer's `layout`
 * prop, which scales the box and visibly squashes the text inside while it
 * runs.
 */
function AutoHeight({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState<number | 'auto'>('auto')
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => setHeight(entry.contentRect.height))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return (
    <motion.div
      animate={{ height }}
      initial={false}
      transition={{ duration: 0.3, ease: EASE }}
      className="overflow-hidden"
    >
      <div ref={ref}>{children}</div>
    </motion.div>
  )
}

function FooterButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-sm text-dark-400 hover:text-dark-50 transition px-3 py-2 rounded-lg"
    >
      {children}
    </button>
  )
}

function PrimaryButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={disabled}
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      whileTap={{ scale: 0.97 }}
      className="text-sm font-semibold rounded-lg px-4 py-2 bg-[#d8ff3e] text-[#08080a] hover:brightness-110 transition-[filter] disabled:opacity-60"
    >
      {children}
    </motion.button>
  )
}
