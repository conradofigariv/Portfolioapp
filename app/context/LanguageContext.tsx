'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, ReactNode } from 'react'
import { translations, Lang } from '../lib/translations'
import { Portfolio, PortfolioBlock, PortfolioBlocks, PortfolioContent, PortfolioMedia, baseLangOf, defaultPortfolio } from '../lib/portfolio'
import { setAtPath } from '../lib/content-path'
import { TOUR_STEPS } from '../lib/onboarding-tour'
import { finishOnboardingTour, pauseOnboardingTour } from '../lib/portfolio-actions'

interface LanguageContextType {
  // Which language the portfolio's own CONTENT is shown/edited in — unrelated
  // to `uiLang` below. Kept as a separate concept on purpose: an owner (or a
  // visitor) building/reading a portfolio in English doesn't necessarily want
  // Spanish as their own base language, or vice versa — see `uiLang`.
  lang: Lang
  // Which language the OWNER's own private editing tools are shown in — the
  // onboarding tour, and the app-language dropdown's own label. Deliberately
  // independent of `lang`: switching which language version of the portfolio
  // you're editing should never silently change the language of your own
  // tools. Detected once from the browser on mount and persisted to
  // localStorage from then on (per-device, not tied to any account — see
  // `setUiLang`); changeable any time via the dropdown under the initials
  // icon in Navbar. Deliberately does NOT cover anything a visitor sees as
  // part of the portfolio itself (nav labels, the CV modal, Contact/Footer/
  // Skills/Projects section headers) — those are part of the page's own
  // bilingual *content* and must track `lang`, not a personal preference of
  // whoever's currently looking at the page. An earlier version of this
  // split put nav/section-header copy under `uiLang` too, which broke the
  // content-language toggle for everything but the raw text fields —
  // reported live as "muchas partes de mi portfolio no pasan a ingles a
  // español." `uiT` below is the fix: a second, narrower interface-copy
  // object, used only by the handful of things that are genuinely the
  // owner's own tooling rather than page content.
  uiLang: Lang
  setUiLang: (lang: Lang) => void
  // Interface copy for the owner's own private tools (the tour, and the
  // app-language dropdown's own label) — driven by `uiLang`. NOT used for
  // anything a visitor sees as part of the portfolio; see `uiLang`'s comment.
  uiT: (typeof translations)['en']
  // Interface copy that's part of the portfolio's own bilingual presentation
  // — nav labels, the CV modal, and every other section's own static
  // headings (Contact/Footer/Skills/Projects) — driven by `lang`, exactly
  // like `content` below, so it always matches whichever language version of
  // the page is currently showing.
  t: (typeof translations)['en']
  // The content of the portfolio being displayed, in the active language.
  content: PortfolioContent
  media: PortfolioMedia
  // Rich text fields migrated to portfolio_blocks. Unlike content, these
  // aren't part of the draft/Save flow — each field autosaves itself
  // independently (see useBlockPersistence). Starts as whatever the server
  // sent on page load, then updated locally via `updateBlock` as each
  // field's own autosave actually completes — see that function's comment
  // for why this can't just be left as a static passthrough of server data.
  blocks: PortfolioBlocks
  // Called by useBlockPersistence right after a block's autosave succeeds,
  // so `blocks` (and therefore what a remounted RichEditableField reloads —
  // see EditableText.tsx's per-language `key`) reflects what was *just*
  // saved, not only what the page happened to load with at the start of the
  // session. Nothing about the scalar-field autosave path ever calls
  // router.refresh()/revalidates the client's own data — deliberately, so
  // typing doesn't risk a mid-edit remount elsewhere on the page — so
  // without this, `blocks` would only ever reflect the very first page
  // load. That was invisible before RichEditableField was keyed by
  // language (the same stale-but-present in-memory editor just kept
  // showing whatever the owner had typed, regardless of what `blocks` said)
  // but became a real, visible regression once toggling languages forces a
  // remount: without this, a field's own just-saved content vanishes back
  // to its pre-session value the moment the owner toggles away from its
  // language and back — confirmed directly (type into a field, toggle
  // away, toggle back: content reverted to the stale pre-edit value) while
  // investigating a report of unpredictable cross-language content changes.
  updateBlock: (blockKey: string, lang: Lang, block: PortfolioBlock) => void
  toggleLang: () => void
  // Editing, only ever true for the portfolio's owner.
  editing: boolean
  dirty: boolean
  draft: Record<Lang, PortfolioContent>
  setField: (path: string, value: string) => void
  // Bumped to Date.now() by useBlockPersistence every time *any* field's
  // autosave completes — separate from `dirty` on purpose, since autosave
  // never touches that. EditBar watches this to flash a brief "Saved"
  // confirmation, independent of whatever dirty/Save is doing.
  lastBlockSavedAt: number | null
  notifyBlockSaved: () => void
  // True while at least one field's autosave request is in flight — a
  // ref-counted "how many blocks are currently saving" rather than a single
  // boolean, since more than one field can be mid-save at once (e.g.
  // tabbing away from one field the instant another's debounce fires). Feeds
  // EditBar's Save button, which is the single place save status shows up
  // now (a per-field indicator in FloatingToolbar was tried and dropped —
  // see EditBar's own comment for why).
  blockSaving: boolean
  notifyBlockSavingStart: () => void
  notifyBlockSavingEnd: () => void
  // Structural edits (add/remove list items) that only ever touch the language
  // being viewed — used for narrative lines, tags, skills, categories, certs
  // and contact items, none of which anything else is keyed to.
  updateActive: (update: (content: PortfolioContent) => PortfolioContent) => void
  // Structural edits that must land on both languages at once, because
  // chapter and project ids are what photos attach to and the two language
  // documents have to keep matching ids.
  updateBoth: (update: (content: PortfolioContent, lang: Lang) => PortfolioContent) => void
  // `savedDraft` is whatever draft object the caller actually persisted (the
  // one it sent to savePortfolio), not "the current one." Only clears `dirty`
  // if the draft hasn't changed since that request went out — if the owner
  // made another edit while the save was still in flight, that edit only
  // ever touched local draft state and was never sent, so clearing `dirty`
  // here would tell the owner (and the beforeunload guard) everything's
  // saved when it isn't. Left `dirty` in that case so Save stays enabled and
  // a follow-up click actually sends the newer edit.
  markSaved: (savedDraft: Record<Lang, PortfolioContent>) => void
  // Onboarding tour (see OnboardingTour.tsx). `active` folds together every
  // reason it might not be showing right now: not the owner's real editor
  // view, already permanently dismissed, the 2s entrance delay hasn't
  // elapsed yet, or it was closed (however) earlier this session.
  tour: {
    active: boolean
    stepIndex: number
    isFirst: boolean
    isLast: boolean
    next: () => void
    back: () => void
    // "Salir" (the small ×): close for now, remembering stepIndex so the
    // tour resumes here next time — unless `remember` is ticked, in which
    // case it behaves like `skipAll` instead. Never both un-persisted and
    // un-resumable at once: it's either "come back to this exact step" or
    // "don't come back at all".
    pause: () => void
    // "Saltear tour": ends it for good, from any step, regardless of
    // `remember` — a one-click "I don't want this" that doesn't need the
    // checkbox ticked first.
    skipAll: () => void
    // Reaching the end and clicking "Entendido": also ends it for good.
    // Same server effect as skipAll, different UI trigger — completing the
    // tour is its own reason to never show it again, independent of the
    // checkbox (which only ever modifies what an early `pause` does).
    finish: () => void
    remember: boolean
    setRemember: (value: boolean) => void
    // The "how do you want to start?" screen holds the tour back while it's
    // up (see StartScreen.tsx); closing it lets the tour begin.
    release: () => void
  }
}

const LanguageContext = createContext<LanguageContextType | null>(null)

const UI_LANG_KEY = 'portfolio-app:ui-lang'

// Same zero-effect "are we genuinely client-side yet" trick OnboardingTour.tsx
// already uses for its own `mounted` flag (see that file's own comment) —
// `getServerSnapshot` covers SSR and the hydration-matching first client
// render, so `localStorage`/`navigator` are never touched before it's safe.
const noopSubscribe = () => () => {}

function detectBrowserLang(): Lang {
  if (typeof navigator === 'undefined') return 'en'
  return navigator.language?.toLowerCase().startsWith('es') ? 'es' : 'en'
}

export function LanguageProvider({
  children,
  portfolio = defaultPortfolio,
  editing = false,
  showTour = false,
  initialTourStep = 0,
  holdTour = false,
}: {
  children: ReactNode
  portfolio?: Portfolio
  editing?: boolean
  // Whether the tour is even eligible to appear at all — decided server-side
  // (owner, not previewing, not already permanently dismissed). See
  // app/[username]/page.tsx.
  showTour?: boolean
  // Which step to resume from, from a previous "Salir". Meaningless unless
  // showTour is also true.
  initialTourStep?: number
  // The tour waits until `tour.release()` — the start screen is up first.
  holdTour?: boolean
}) {
  const [lang, setLang] = useState<Lang>(() => baseLangOf(portfolio.blocks))

  // uiLang: detected once from the browser, then persisted to localStorage —
  // completely separate from `lang` above (content language). `mounted`
  // gates the one-time hydration so it only ever runs once this is safe to
  // read (never during SSR or the hydration-matching first client render).
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false)
  const [uiLang, setUiLangState] = useState<Lang>('en')
  // Guards the hydration below to only ever run once — a plain useState
  // rather than a ref, since react-hooks/refs (this project's stricter lint
  // config) flags reading/writing a ref's `.current` during render outside
  // its one sanctioned `if (ref.current == null)` lazy-init shape. Calling
  // setState conditionally *during* render (not inside a bare useEffect) is
  // React's own sanctioned way to adjust state in response to something
  // becoming available — the same render-time-comparison pattern EditBar's
  // `justSaved` flash already uses; setting two state pieces from the same
  // conditional block is still just that one pattern applied twice.
  const [uiLangHydrated, setUiLangHydrated] = useState(false)
  if (mounted && !uiLangHydrated) {
    setUiLangHydrated(true)
    let stored: string | null = null
    try {
      stored = window.localStorage.getItem(UI_LANG_KEY)
    } catch {
      // Storage can throw (private browsing, blocked cookies) — falls back
      // to browser detection below, same as never having a stored value.
    }
    const initial: Lang = stored === 'en' || stored === 'es' ? stored : detectBrowserLang()
    if (initial !== uiLang) setUiLangState(initial)
  }

  function setUiLang(next: Lang) {
    setUiLangState(next)
    try {
      window.localStorage.setItem(UI_LANG_KEY, next)
    } catch {
      // Best-effort persistence — a viewer with storage blocked still gets
      // the change for the rest of this session, just not remembered.
    }
  }

  const [draft, setDraft] = useState(portfolio.content)
  const [dirty, setDirty] = useState(false)
  const [blocksState, setBlocksState] = useState(portfolio.blocks)
  // Resyncs blocksState from scratch whenever the `portfolio` prop's own
  // `blocks` genuinely changes — i.e. after a real server refresh (a block
  // list's add/remove/reorder already calls router.refresh() on success;
  // navigating to this page fresh does too). Without this, blocksState —
  // needed so a single field's own autosave can update local state without
  // the disruptive full-page refresh a list action uses (see `updateBlock`
  // below) — would otherwise never learn about changes made any other way.
  // Comparing the incoming prop against a state value held from last render
  // and adjusting state conditionally *during* render (not inside a bare
  // useEffect, which react-hooks/set-state-in-effect flags) is the same
  // pattern already used for `uiLangHydrated` above and EditBar's `justSaved`
  // flash.
  const [syncedBlocksSource, setSyncedBlocksSource] = useState(portfolio.blocks)
  if (portfolio.blocks !== syncedBlocksSource) {
    setSyncedBlocksSource(portfolio.blocks)
    setBlocksState(portfolio.blocks)
  }
  // Stable reference for the same reason notifyBlockSaved below is — passed
  // into every mounted useBlockPersistence's own useCallback deps, and an
  // unstable function here would tear down/re-attach every editor's
  // update/blur listeners on every keystroke elsewhere on the page.
  const updateBlock = useCallback((blockKey: string, lang: Lang, block: PortfolioBlock) => {
    setBlocksState((prev) => ({ ...prev, [blockKey]: { ...prev[blockKey], [lang]: block } }))
  }, [])
  // Mirrors `draft` so markSaved can compare against the *latest* draft
  // (as of the most recent render) from inside an async callback, without
  // that callback needing its own stale closure over `draft`.
  const draftRef = useRef(draft)
  useEffect(() => {
    draftRef.current = draft
  }, [draft])
  const [lastBlockSavedAt, setLastBlockSavedAt] = useState<number | null>(null)
  const [savingCount, setSavingCount] = useState(0)
  // Stable across renders (unlike an inline arrow in the provider value
  // below) so it doesn't churn useBlockPersistence's own useCallback deps —
  // this context re-renders on every keystroke in an old-system field, and
  // every mounted Tiptap editor's update/blur listeners would otherwise be
  // torn down and re-attached on each one.
  const notifyBlockSaved = useCallback(() => setLastBlockSavedAt(Date.now()), [])
  const notifyBlockSavingStart = useCallback(() => setSavingCount((n) => n + 1), [])
  // Floored at 0 — a field can call this from its unmount-flush effect after
  // its own save() already settled and decremented once, so the count must
  // never go negative from a double-decrement.
  const notifyBlockSavingEnd = useCallback(() => setSavingCount((n) => Math.max(0, n - 1)), [])

  const toggleLang = () => setLang((l) => (l === 'en' ? 'es' : 'en'))

  function updateActive(update: (content: PortfolioContent) => PortfolioContent) {
    setDraft((prev) => ({ ...prev, [lang]: update(prev[lang]) }))
    setDirty(true)
  }

  function updateBoth(update: (content: PortfolioContent, lang: Lang) => PortfolioContent) {
    setDraft((prev) => ({ en: update(prev.en, 'en'), es: update(prev.es, 'es') }))
    setDirty(true)
  }

  // Edits land on the language being viewed; the other one is untouched.
  function setField(path: string, value: string) {
    updateActive((current) => setAtPath(current, path, value))
  }

  // --- Onboarding tour ---
  const [tourClosed, setTourClosed] = useState(false)
  const [stepIndex, setStepIndex] = useState(initialTourStep)
  const [remember, setRemember] = useState(false)

  // The page itself renders instantly either way — this only delays the
  // tour's first appearance, so the owner sees their own content first and
  // the guide starts a beat later rather than competing with it for
  // attention the moment the page appears. setState inside a setTimeout
  // callback (as opposed to synchronously in the effect body) is what makes
  // a plain effect fine here rather than needing the useSyncExternalStore
  // workaround OnboardingTour.tsx uses for its document.body access — that
  // rule only flags a synchronous call in the effect body itself.
  const [tourReady, setTourReady] = useState(false)
  const [tourHeld, setTourHeld] = useState(holdTour)
  useEffect(() => {
    if (!showTour || tourHeld) return
    const timer = setTimeout(() => setTourReady(true), 2000)
    return () => clearTimeout(timer)
  }, [showTour, tourHeld])

  const tourActive = showTour && !tourHeld && tourReady && !tourClosed
  const isLastStep = stepIndex >= TOUR_STEPS.length - 1

  function tourNext() {
    setStepIndex((i) => Math.min(i + 1, TOUR_STEPS.length - 1))
  }
  function tourBack() {
    setStepIndex((i) => Math.max(i - 1, 0))
  }
  function tourPause() {
    setTourClosed(true)
    if (remember) void finishOnboardingTour()
    else void pauseOnboardingTour(stepIndex)
  }
  function tourSkipAll() {
    setTourClosed(true)
    void finishOnboardingTour()
  }
  function tourFinish() {
    setTourClosed(true)
    void finishOnboardingTour()
  }

  return (
    <LanguageContext.Provider
      value={{
        lang,
        uiLang,
        setUiLang,
        uiT: translations[uiLang],
        t: translations[lang],
        content: draft[lang],
        media: portfolio.media,
        blocks: blocksState,
        updateBlock,
        toggleLang,
        editing,
        dirty,
        draft,
        setField,
        updateActive,
        updateBoth,
        markSaved: (savedDraft) => {
          if (draftRef.current === savedDraft) setDirty(false)
        },
        lastBlockSavedAt,
        notifyBlockSaved,
        blockSaving: savingCount > 0,
        notifyBlockSavingStart,
        notifyBlockSavingEnd,
        tour: {
          active: tourActive,
          stepIndex,
          isFirst: stepIndex === 0,
          isLast: isLastStep,
          next: tourNext,
          back: tourBack,
          pause: tourPause,
          skipAll: tourSkipAll,
          finish: tourFinish,
          remember,
          setRemember,
          release: () => setTourHeld(false),
        },
      }}
    >
      {children}
    </LanguageContext.Provider>
  )
}

export function useLang() {
  const ctx = useContext(LanguageContext)
  if (!ctx) throw new Error('useLang must be used inside LanguageProvider')
  return ctx
}
