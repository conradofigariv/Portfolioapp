'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, MotionConfig, motion } from 'framer-motion'
import { useLang } from '../context/LanguageContext'
import { checkUsername, changeUsername, type UsernameStatus } from '../lib/username-actions'
import { normalizeUsernameInput, usernameProblem } from '../lib/username'

const noopSubscribe = () => () => {}

/**
 * The owner's address (/<username>): chosen once when a new account first
 * opens its page (`mode="first"`, the Google-derived suggestion prefilled),
 * and changeable later from EditBar's "Link" (`mode="change"`).
 *
 * Changing it leaves the old address redirecting for 90 days, then free for
 * anyone (migration 0018) — the product owner's call, so the change screen
 * says so plainly before the owner confirms. Owner-only tooling: its text is
 * `uiT`, the app language, not the content language.
 *
 * After a save the page is loaded fresh at the (possibly new) address rather
 * than refreshed in place: the URL changes, and a fresh load is also what lets
 * the onboarding tour start, since it waits for this to be done.
 */
export default function UsernamePicker({
  open,
  mode,
  current,
  onClose,
}: {
  open: boolean
  mode: 'first' | 'change'
  current: string
  onClose: () => void
}) {
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false)
  if (!mounted) return null
  return createPortal(
    <MotionConfig reducedMotion="user">
      <AnimatePresence>
        {open && <PickerDialog key="picker" mode={mode} current={current} onClose={onClose} />}
      </AnimatePresence>
    </MotionConfig>,
    document.body
  )
}

function PickerDialog({ mode, current, onClose }: { mode: 'first' | 'change'; current: string; onClose: () => void }) {
  const { uiT } = useLang()
  const c = uiT.username
  const [value, setValue] = useState(current)
  const [checked, setChecked] = useState<{ value: string; status: UsernameStatus } | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // What's known without asking the server: a malformed name, or the one the
  // owner already has. Anything else waits for the (debounced) check below.
  const problem = usernameProblem(value)
  const status: UsernameStatus | 'checking' = problem
    ? problem
    : value === current
      ? 'current'
      : checked?.value === value
        ? checked.status
        : 'checking'

  useEffect(() => {
    if (usernameProblem(value) || value === current) return
    let cancelled = false
    const timer = setTimeout(async () => {
      const result = await checkUsername(value)
      if (cancelled) return
      if (result.ok) setChecked({ value: result.username, status: result.status })
      else setError(c.errors[result.error] ?? c.errors.generic)
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [value, current, c])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  const canSave = !saving && (status === 'available' || status === 'current')
  const changing = status !== 'current'

  async function save() {
    if (!canSave) return
    setSaving(true)
    setError(null)
    const result = await changeUsername(value)
    if (result.ok) {
      // A full load on purpose, not router.push: the URL may have changed,
      // and the provider's tour state only starts on a fresh page.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign(`/${result.username}`)
      return
    }
    setSaving(false)
    setError(c.errors[result.error] ?? c.errors.generic)
  }

  const host = typeof window !== 'undefined' ? window.location.host : ''
  const tone =
    status === 'available'
      ? 'text-[#d8ff3e]'
      : status === 'current' || status === 'checking'
        ? 'text-dark-400'
        : 'text-amber-200/90'

  return (
    <motion.div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={() => !saving && onClose()}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="username-picker-title"
        className="w-full max-w-md rounded-2xl border border-dark-700 bg-dark-900 p-5 md:p-6 shadow-2xl"
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.98 }}
        transition={{ type: 'spring', stiffness: 380, damping: 32 }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="username-picker-title" className="text-lg font-semibold text-dark-50">
          {mode === 'first' ? c.titleFirst : c.titleChange}
        </h2>
        <p className="mt-1 text-sm text-dark-400">{mode === 'first' ? c.introFirst : c.introChange}</p>

        <form
          className="mt-5"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <label className="flex items-center rounded-xl border border-dark-600 bg-dark-800/60 focus-within:border-dark-300 transition-colors">
            <span className="shrink-0 pl-3 text-sm text-dark-500 max-w-[45%] truncate">{host}/</span>
            <input
              autoFocus
              value={value}
              onChange={(e) => {
                setError(null)
                setValue(normalizeUsernameInput(e.target.value))
              }}
              spellCheck={false}
              autoCapitalize="none"
              autoComplete="off"
              maxLength={30}
              aria-describedby="username-picker-status"
              className="min-w-0 flex-1 bg-transparent py-2.5 pr-3 text-sm text-dark-50 outline-none"
            />
          </label>

          <p id="username-picker-status" aria-live="polite" className={`mt-2 min-h-[1.25rem] text-xs ${tone}`}>
            {/* A failed check shows its error below instead of "Checking…" forever. */}
            {!(error && status === 'checking') && (
              <>
                {status === 'available' && '✓ '}
                {c[status]}
              </>
            )}
          </p>

          {mode === 'change' && changing && status === 'available' && (
            <p className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2 text-xs leading-relaxed text-amber-100/90">
              {c.warning(current)}
            </p>
          )}

          {error && <p className="mt-3 text-xs text-red-400">{error}</p>}

          <div className="mt-5 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="text-sm text-dark-400 hover:text-dark-50 transition disabled:opacity-50"
            >
              {mode === 'first' ? c.later : c.cancel}
            </button>
            <button
              type="submit"
              disabled={!canSave || (mode === 'change' && !changing)}
              className="rounded-full bg-[#d8ff3e] px-5 py-2 text-sm font-semibold text-[#08080a] transition hover:brightness-110 disabled:opacity-40"
            >
              {saving ? c.saving : mode === 'first' ? c.keep : c.change}
            </button>
          </div>
        </form>
      </motion.div>
    </motion.div>
  )
}
