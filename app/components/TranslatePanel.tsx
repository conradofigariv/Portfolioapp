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
import type { JSONContent } from '@tiptap/core'
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
import {
  applyTranslationReview,
  previewTranslation,
  translateChunk,
  translateReviewChunk,
  type ReviewView,
} from '../lib/translate/translate-actions'
import { runTranslation } from '../lib/translate/run-translation'
import type { ListChoice } from '../lib/translate/plan'
import type { ChunkFailure, TranslatedItem } from '../lib/translate/translate-batch'

/**
 * The owner's view of a translation run (steps 5 and 6 of the feature).
 *
 * The whole loop lives here rather than on the server, which is the point of
 * the chunked design (see translate-actions.ts): each call is one model call
 * inside one serverless function, and the client is what decides whether to ask
 * for another. Closing this panel mid-run doesn't roll anything back, and
 * reopening it simply plans again from whatever is already translated.
 *
 * A run is **fill, then review**:
 *
 * 1. Fields with nothing in the target language (and lists whose target is
 *    empty) are translated and written straight away, with a live feed.
 * 2. Anything that already has content there — a field edited in the source
 *    since it was translated, a list with its own items — is translated
 *    *without writing*, and shown on a review screen: current text vs the
 *    translation for fields, and for each list an animated preview of what it
 *    would become under each choice (keep / update / replace / remove copies).
 *    Only what the owner accepts is written, by `applyTranslationReview`.
 *
 * Added after a real run duplicated every hand-written Spanish list item: the
 * owner asked for "a preview before applying", and picked this split — no
 * review for what can't overwrite anything, a review for everything that can.
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
  /** Fill: writing empty fields. */
  | 'running'
  /** Review: translating what already has content, without writing. */
  | 'preparing'
  | 'review'
  | 'applying'
  | 'done'
  | 'partial'
  | 'stopped'
  /** A run that ended on an error, with whatever it saved before that. */
  | 'failed'
  /** The preview itself failed — nothing ran. */
  | 'error'

type Choice = ListChoice | 'keep'
type Doc = { json: JSONContent; result: string }
type ReviewList = ReviewView['lists'][number]

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
  const [counts, setCounts] = useState<{ missing: number; review: number } | null>(null)
  const [done, setDone] = useState(0)
  const [total, setTotal] = useState(0)
  const [items, setItems] = useState<TranslatedItem[]>([])
  /** Fill failures — the only ones "Retry N" can do anything about. */
  const [failures, setFailures] = useState<ChunkFailure[]>([])
  /** Review/apply failures — shown, not retried from here. */
  const [otherFailures, setOtherFailures] = useState<ChunkFailure[]>([])
  const [removed, setRemoved] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const [review, setReview] = useState<ReviewView | null>(null)
  const [docs, setDocs] = useState<Record<string, Doc>>({})
  const [accepted, setAccepted] = useState<Set<string>>(new Set())
  const [choices, setChoices] = useState<Record<string, Choice>>({})

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
      setOtherFailures([])
      setRemoved(0)
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
      setCounts({ missing: result.missing, review: result.stale + result.lists })
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

  function finish(next: Phase) {
    setPhase(next)
    // Whatever landed has to become visible: the actions revalidate the cache
    // server-side, but this page still holds the pre-run blocks until it
    // refetches. Done once at the end rather than per chunk — a refresh
    // mid-run would remount every field underneath the owner.
    startRefresh(() => router.refresh())
  }

  /**
   * `keep` carries the items of the run before (a retry of what failed), so
   * the summary still describes everything this panel translated. `fillOnly`
   * is that retry: it's about the fields that failed to fill, not a second
   * pass through review.
   */
  async function run(expected: number, keep: boolean, fillOnly: boolean) {
    stopRef.current = false
    setError(null)
    setFailures([])
    setDone(0)
    setTotal(expected)
    if (!keep) {
      setItems([])
      setOtherFailures([])
      setRemoved(0)
    }

    let fillFailures: ChunkFailure[] = []
    if (expected > 0) {
      setPhase('running')
      const outcome = await runTranslation({
        chunk: (limit, skip) => translateChunk({ from, to, limit, skip }),
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
      if (outcome.status !== 'done') fillFailures = outcome.failures
      setFailures(fillFailures)
      if (outcome.status === 'stopped') return finish('stopped')
      if (outcome.status === 'error') {
        setError(outcome.error)
        return finish('failed')
      }
    }
    const settled: Phase = fillFailures.length > 0 ? 'partial' : 'done'
    if (fillOnly) return finish(settled)

    // Review. Re-read rather than reusing the start screen's view: the page
    // may have changed, and this is what the owner will be deciding on.
    const preview = await previewTranslation({ from, to })
    if (!preview.ok) {
      setError(preview.error)
      return finish('failed')
    }
    const view = preview.review
    if (view.fields.length === 0 && view.lists.length === 0) return finish(settled)

    const reviewKeys = new Set([
      ...view.fields.map((f) => f.blockKey),
      ...view.lists.flatMap((l) => l.source.flatMap((item) => item.keys)),
    ])
    setReview(view)
    setDocs({})
    setDone(0)
    setTotal(reviewKeys.size)
    setPhase('preparing')

    const collected: Record<string, Doc> = {}
    const outcome = await runTranslation({
      chunk: (limit, skip) => translateReviewChunk({ from, to, limit, skip }),
      limit: CHUNK,
      shouldStop: () => stopRef.current,
      skipSucceeded: true,
      onProgress: (translated, live) => {
        setDone(translated)
        setTotal(live)
      },
      onChunk: (result) => {
        for (const item of result.written) {
          if (item.json) collected[item.blockKey] = { json: item.json, result: item.result }
        }
        setDocs({ ...collected })
      },
    })
    if (outcome.status === 'stopped') return finish(settled === 'partial' ? 'partial' : 'stopped')
    if (outcome.status === 'error') {
      setError(outcome.error)
      return finish('failed')
    }

    // Defaults: every stale field that got a translation is ticked (the owner
    // edited the source, so updating is the likely intent — and nothing is
    // written until Apply anyway). A list starts on "keep", except an aligned
    // list whose only differences are *edited* items: there "update" can't
    // add anything unexpected, it only refreshes lines that were translated
    // before. Anything that adds, replaces or removes items waits for a click.
    setAccepted(new Set(view.fields.filter((f) => collected[f.blockKey]).map((f) => f.blockKey)))
    const initial: Record<string, Choice> = {}
    for (const list of view.lists) {
      const onlyEdits = list.source.every((item) => item.status !== 'new')
      initial[list.prefix] =
        list.choices.includes('sync') && onlyEdits && canApply(list, 'sync', collected) ? 'sync' : 'keep'
    }
    setChoices(initial)
    setPhase('review')
  }

  async function apply() {
    if (!review) return
    setPhase('applying')
    const lists = review.lists
      .map((list) => ({ prefix: list.prefix, choice: choices[list.prefix] ?? 'keep' }))
      .filter((entry): entry is { prefix: string; choice: ListChoice } => entry.choice !== 'keep')
    const needed = new Set<string>([...accepted])
    for (const { prefix, choice } of lists) {
      const list = review.lists.find((l) => l.prefix === prefix)!
      for (const key of keysFor(list, choice)) needed.add(key)
    }
    const result = await applyTranslationReview({
      from,
      to,
      fields: [...accepted],
      lists,
      translations: [...needed].filter((key) => docs[key]).map((key) => ({ blockKey: key, json: docs[key].json })),
    })
    if (!result.ok) {
      setError(result.error)
      return finish('failed')
    }
    setItems((prev) => [...prev, ...result.written])
    setRemoved((n) => n + result.removed)
    setOtherFailures(result.failures)
    finish(failures.length > 0 || result.failures.length > 0 ? 'partial' : 'done')
  }

  const c = uiT.translate
  const nothingToDo = phase === 'ready' && counts !== null && counts.missing === 0 && counts.review === 0
  const canStart = phase === 'ready' && counts !== null && !nothingToDo
  const isSummary = phase === 'done' || phase === 'partial' || phase === 'stopped' || phase === 'failed'
  const bodyKey = isSummary ? 'summary' : phase
  const changes =
    accepted.size + Object.values(choices).filter((choice) => choice !== 'keep').length

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
              className="relative w-full max-w-md max-h-[88vh] overflow-y-auto rounded-2xl border border-dark-700/80 bg-dark-900 shadow-2xl"
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
                  // there. Closing on the review screen writes nothing.
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
                              <Counter value={counts.missing > 0 ? counts.missing : counts.review} />
                            </div>
                            <p className="mt-1 text-sm text-dark-400">
                              {counts.missing > 0 ? c.toTranslate(c.langName[to]) : c.toReview}
                            </p>
                          </div>
                          {counts.missing > 0 && counts.review > 0 && (
                            <p className="text-xs text-dark-500 leading-relaxed rounded-xl border border-dark-700/70 px-3.5 py-3">
                              {c.reviewNote(counts.review, c.langName[to])}
                            </p>
                          )}
                        </div>
                      )}

                      {(phase === 'running' || phase === 'preparing') && (
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
                              {phase === 'running' ? c.running : c.preparing}
                              <Dots />
                            </p>
                          </div>
                          <ProgressBar value={total > 0 ? done / total : 0} />
                          {phase === 'running' && <LiveFeed items={items} />}
                        </div>
                      )}

                      {phase === 'review' && review && (
                        <ReviewStep
                          review={review}
                          docs={docs}
                          source={c.langName[from]}
                          target={c.langName[to]}
                          accepted={accepted}
                          onToggle={(key) =>
                            setAccepted((prev) => {
                              const next = new Set(prev)
                              if (next.has(key)) next.delete(key)
                              else next.add(key)
                              return next
                            })
                          }
                          choices={choices}
                          onChoose={(prefix, choice) => setChoices((prev) => ({ ...prev, [prefix]: choice }))}
                        />
                      )}

                      {phase === 'applying' && (
                        <div className="space-y-5" aria-live="polite">
                          <p className="text-sm text-dark-400">
                            {c.applying}
                            <Dots />
                          </p>
                          <ProgressBar value={1} />
                        </div>
                      )}

                      {isSummary && (
                        <Summary
                          phase={phase}
                          items={items}
                          failures={failures}
                          otherFailures={otherFailures}
                          removed={removed}
                          error={error}
                          onRetryFailed={() => void run(failures.length, true, true)}
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

              {/* Sticky: the review step can be taller than the panel, and its
                  Apply button must stay reachable without scrolling to the end. */}
              <div className="sticky bottom-0 z-10 flex items-center justify-end gap-2 px-5 pb-5 pt-3 bg-dark-900 shadow-[0_-12px_16px_-8px_rgba(0,0,0,0.6)]">
                {phase === 'running' || phase === 'preparing' ? (
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
                ) : phase === 'applying' ? null : phase === 'review' ? (
                  <>
                    {/* Skipping writes nothing from the review; what the fill
                        part already wrote stays. */}
                    <FooterButton onClick={() => finish(failures.length > 0 ? 'partial' : 'done')}>
                      {c.skip}
                    </FooterButton>
                    <PrimaryButton disabled={changes === 0} onClick={() => void apply()}>
                      {c.apply(changes)}
                    </PrimaryButton>
                  </>
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
                    {(phase === 'done' || phase === 'partial') && (items.length > 0 || removed > 0) && lang !== to && (
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
                    {canStart && counts !== null && (
                      <PrimaryButton onClick={() => void run(counts.missing, false, false)}>{c.start}</PrimaryButton>
                    )}
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
/* Review                                                                     */

/** The source fields a list choice writes — mirrors the server's own rule. */
function keysFor(list: ReviewList, choice: Choice): string[] {
  if (choice === 'keep' || choice === 'dedupe') return []
  return list.source.filter((item) => choice === 'replace' || item.status !== 'shared').flatMap((item) => item.keys)
}

/** Whether every translation a choice needs actually came back. */
function canApply(list: ReviewList, choice: Choice, docs: Record<string, Doc>): boolean {
  return keysFor(list, choice).every((key) => docs[key])
}

type Row = {
  key: string
  text: string
  state: 'kept' | 'removed' | 'added' | 'changed'
  before?: string
  /** A target item that came from an earlier translation, in a list that also has the owner's own. */
  copy?: boolean
}

/**
 * What the list would look like under `choice`, row by row — the animated
 * preview. Row keys are stable per item (`t-<id>` for what's in the target
 * now, `s-<id>` for what a choice brings in), so switching choice animates
 * each row from one state to the next instead of redrawing the list.
 */
function resultRows(list: ReviewList, choice: Choice, docs: Record<string, Doc>): Row[] {
  const translated = (item: ReviewList['source'][number]) =>
    item.keys
      .map((key) => docs[key]?.result)
      .filter(Boolean)
      .join(' — ')
  const sourceById = new Map(list.source.map((item) => [item.itemId, item]))
  // Only worth pointing out when the list mixes both — in an aligned list
  // every item is a "copy", and the tag would just be noise.
  const mixed = list.choices.includes('dedupe')
  const target = (state: Row['state'] = 'kept') =>
    list.target.map((item) => ({ key: `t-${item.itemId}`, text: item.text, state, copy: mixed && item.shared }))

  if (choice === 'keep') return target()
  if (choice === 'replace') {
    return [
      ...target('removed'),
      ...list.source.map((item) => ({ key: `s-${item.itemId}`, text: translated(item), state: 'added' as const })),
    ]
  }
  if (choice === 'dedupe') {
    return list.target.map((item) => ({
      key: `t-${item.itemId}`,
      text: item.text,
      state: item.shared ? ('removed' as const) : ('kept' as const),
      copy: item.shared,
    }))
  }
  // sync
  return [
    ...list.target.map((item) => {
      const source = sourceById.get(item.itemId)
      return source?.status === 'changed'
        ? { key: `t-${item.itemId}`, text: translated(source), state: 'changed' as const, before: item.text }
        : { key: `t-${item.itemId}`, text: item.text, state: 'kept' as const }
    }),
    ...list.source
      .filter((item) => item.status === 'new')
      .map((item) => ({ key: `s-${item.itemId}`, text: translated(item), state: 'added' as const })),
  ]
}

function ReviewStep({
  review,
  docs,
  source,
  target,
  accepted,
  onToggle,
  choices,
  onChoose,
}: {
  review: ReviewView
  docs: Record<string, Doc>
  source: string
  target: string
  accepted: Set<string>
  onToggle: (blockKey: string) => void
  choices: Record<string, Choice>
  onChoose: (prefix: string, choice: Choice) => void
}) {
  const { uiT } = useLang()
  const c = uiT.translate
  let index = 0
  const stagger = () => ({ delay: 0.05 + index++ * 0.05, duration: 0.3, ease: EASE })

  return (
    <div className="space-y-4">
      <div>
        <p className="text-base font-medium text-dark-50">{c.reviewTitle}</p>
        <p className="mt-1 text-xs text-dark-500 leading-relaxed">{c.reviewIntro(target)}</p>
        {review.lists.length > 0 && (
          // The same three marks the list previews use, spelled out once.
          <p className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-dark-500">
            <span>
              <span className="text-[#d8ff3e]">+</span> {c.legendAdded}
            </span>
            <span>
              <span className="text-red-400/80">−</span> {c.legendRemoved}
            </span>
            <span>
              <span className="text-[#d8ff3e]">~</span> {c.legendChanged}
            </span>
          </p>
        )}
      </div>

      <div className="space-y-2.5">
        {review.fields.map((field) => {
          const doc = docs[field.blockKey]
          const on = accepted.has(field.blockKey)
          return (
            <motion.label
              key={field.blockKey}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={stagger()}
              className={`block rounded-xl border px-3.5 py-3 transition-colors ${
                doc ? 'cursor-pointer' : 'opacity-60'
              } ${on ? 'border-[#d8ff3e]/30 bg-[#d8ff3e]/[0.03]' : 'border-dark-700/70 hover:border-dark-600'}`}
            >
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={on}
                  disabled={!doc}
                  onChange={() => onToggle(field.blockKey)}
                  className="mt-0.5 accent-[#d8ff3e]"
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="text-[11px] text-dark-500">
                    <span className="uppercase tracking-wider">{c.sections[field.section] ?? field.section}</span>
                    <span className="text-dark-600"> · </span>
                    {c.changedIn(source)}
                  </p>
                  <motion.p
                    animate={{ opacity: on ? 0.45 : 1 }}
                    className={`text-xs text-dark-300 line-clamp-2 ${on ? 'line-through decoration-dark-500' : ''}`}
                  >
                    {field.current}
                  </motion.p>
                  <Collapse open={on && !!doc}>
                    <p className="pt-0.5 text-sm text-dark-50 line-clamp-3">{doc?.result}</p>
                  </Collapse>
                  {!doc && <p className="text-[11px] text-amber-200/70">{c.noTranslation}</p>}
                </div>
              </div>
            </motion.label>
          )
        })}

        {review.lists.map((list) => (
          <motion.div
            key={list.prefix}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={stagger()}
          >
            <ListCard
              list={list}
              docs={docs}
              source={source}
              choice={choices[list.prefix] ?? 'keep'}
              onChoose={onChoose}
            />
          </motion.div>
        ))}
      </div>
    </div>
  )
}

function ListCard({
  list,
  docs,
  source,
  choice,
  onChoose,
}: {
  list: ReviewList
  docs: Record<string, Doc>
  source: string
  choice: Choice
  onChoose: (prefix: string, choice: Choice) => void
}) {
  const { uiT } = useLang()
  const c = uiT.translate
  const rows = resultRows(list, choice, docs)
  const options: Choice[] = ['keep', ...list.choices]
  const hasCopies = list.choices.includes('dedupe')
  const title = [c.sections[list.section] ?? list.section, list.parentTitle].filter(Boolean).join(' · ')

  return (
    <div
      className={`rounded-xl border px-3.5 py-3 space-y-3 transition-colors ${
        choice === 'keep' ? 'border-dark-700/70' : 'border-[#d8ff3e]/30 bg-[#d8ff3e]/[0.03]'
      }`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm text-dark-100 truncate">{title}</p>
        <p className="shrink-0 text-[11px] uppercase tracking-wider text-dark-500">{c.kinds[list.kind] ?? list.kind}</p>
      </div>
      {hasCopies && <p className="text-[11px] text-amber-200/70 -mt-1.5">{c.copiesHint}</p>}

      <div className="flex flex-wrap gap-1 rounded-full border border-dark-700 p-0.5 w-fit max-w-full">
        {options.map((option) => {
          const active = option === choice
          const available = canApply(list, option, docs)
          return (
            <button
              key={option}
              type="button"
              disabled={!available}
              onClick={() => onChoose(list.prefix, option)}
              aria-pressed={active}
              className={`relative text-[11px] px-2.5 py-1 rounded-full transition-colors disabled:opacity-30 ${
                active ? 'text-dark-900 font-semibold' : 'text-dark-400 hover:text-dark-100'
              }`}
            >
              {active && (
                <motion.span
                  layoutId={`choice-${list.prefix}`}
                  className="absolute inset-0 rounded-full bg-dark-50"
                  transition={{ type: 'spring', stiffness: 500, damping: 38 }}
                />
              )}
              <span className="relative">{c.choices[option]}</span>
            </button>
          )
        })}
      </div>

      {/* What the selected choice does, in words — the preview below shows
          the result, this says the rule. Reported as "lindo pero no muy claro
          cómo funciona" with only the preview to go on. */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.p
          key={choice}
          initial={{ opacity: 0, y: 3 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -3 }}
          transition={{ duration: 0.15 }}
          className="-mt-1 text-[11px] text-dark-400 leading-relaxed"
        >
          {c.choiceHelp(choice, source)}
        </motion.p>
      </AnimatePresence>

      <ul className="space-y-1">
        <AnimatePresence initial={false}>
          {rows.map((row) => (
            <motion.li
              key={row.key}
              layout="position"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.25, ease: EASE }}
              className="overflow-hidden"
            >
              <div className="flex items-start gap-2 py-0.5">
                <span
                  aria-hidden
                  className={`w-3 shrink-0 text-center text-xs leading-5 ${
                    row.state === 'added' || row.state === 'changed'
                      ? 'text-[#d8ff3e]'
                      : row.state === 'removed'
                        ? 'text-red-400/80'
                        : 'text-dark-600'
                  }`}
                >
                  {row.state === 'added' ? '+' : row.state === 'removed' ? '−' : row.state === 'changed' ? '~' : '·'}
                </span>
                <div className="min-w-0">
                  {row.before && <p className="text-[11px] text-dark-500 line-through line-clamp-1">{row.before}</p>}
                  <motion.p
                    animate={{ opacity: row.state === 'removed' ? 0.45 : 1 }}
                    className={`text-xs leading-5 line-clamp-2 ${
                      row.state === 'removed'
                        ? 'text-dark-400 line-through decoration-red-400/50'
                        : row.state === 'kept'
                          ? 'text-dark-300'
                          : 'text-dark-50'
                    }`}
                  >
                    {row.copy && (
                      <span className="mr-1.5 inline-block align-[1px] rounded border border-amber-400/30 px-1 text-[9px] uppercase tracking-wider text-amber-200/80 no-underline">
                        {c.copyTag}
                      </span>
                    )}
                    {row.text}
                  </motion.p>
                </div>
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </div>
  )
}

/* ------------------------------------------------------------------------ */

function Summary({
  phase,
  items,
  failures,
  otherFailures,
  removed,
  error,
  onRetryFailed,
}: {
  phase: Phase
  items: TranslatedItem[]
  failures: ChunkFailure[]
  otherFailures: ChunkFailure[]
  removed: number
  error: string | null
  onRetryFailed: () => void
}) {
  const { uiT } = useLang()
  const c = uiT.translate
  const [openSection, setOpenSection] = useState<string | null>(null)
  const [showFailed, setShowFailed] = useState(false)

  const groups = groupBySection(items)
  const allFailures = [...failures, ...otherFailures]
  // The common case is one error for every failed field (the service was
  // overloaded) — said once above the list, not repeated on every line.
  const sharedError =
    allFailures.length > 0 && allFailures.every((f) => f.error === allFailures[0].error) ? allFailures[0].error : null

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
          {removed > 0 && <p className="mt-1.5 text-xs text-dark-400">{c.removed(removed)}</p>}
          {phase === 'failed' && (
            <p className="mt-2 text-sm text-dark-200 leading-relaxed">
              <span className="text-dark-50 font-medium">{c.failedTitle}.</span> {error}
            </p>
          )}
          {phase === 'failed' && items.length > 0 && <p className="mt-1 text-xs text-dark-500">{c.continueHint}</p>}
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

      {(phase === 'partial' || phase === 'done') && allFailures.length > 0 && (
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
              {c.didntGoThrough(allFailures.length)}
              <Chevron open={showFailed} />
            </button>
            {failures.length > 0 && (
              <button
                type="button"
                onClick={onRetryFailed}
                className="shrink-0 text-xs font-medium text-dark-50 rounded-full border border-dark-600 px-3 py-1 hover:bg-dark-800 transition"
              >
                {c.retryFailed(failures.length)}
              </button>
            )}
          </div>
          <Collapse open={showFailed}>
            <div className="px-3.5 pb-3 space-y-2">
              {sharedError && <p className="text-[11px] text-amber-200/70">{sharedError}</p>}
              <ul className="space-y-1.5 max-h-48 overflow-y-auto">
                {allFailures.map((f) => (
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
