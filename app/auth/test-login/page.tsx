'use client'

import { useState } from 'react'
import { createClient } from '../../lib/supabase/client'

/**
 * Sign-in for **test accounts** only (email + password, created by hand in
 * Supabase → Authentication → Users → Add user, "Auto Confirm User" ticked).
 * Real accounts sign in with Google from the landing page; this exists so the
 * onboarding can be run again and again without a new Google account each
 * time — a test account can be reset to a brand-new one from EditBar (see
 * app/lib/test-account.ts). Not linked from anywhere.
 */
export default function TestLoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error } = await createClient().auth.signInWithPassword({ email: email.trim(), password })
    if (error) {
      setBusy(false)
      setError(error.message)
      return
    }
    // A full load, so /admin reads the new session from its cookies.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign('/admin')
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-dark-900 px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-dark-700 bg-dark-800/40 p-6">
        <p className="text-[11px] font-mono uppercase tracking-wider text-amber-200/80">Test accounts</p>
        <h1 className="mt-1 text-xl font-semibold text-dark-50">Sign in to a test account</h1>
        <p className="mt-1 text-xs text-dark-400">Real accounts sign in with Google on the home page.</p>
        <label className="mt-5 block text-xs text-dark-300">
          Email
          <input
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-lg border border-dark-600 bg-dark-900 px-3 py-2 text-sm text-dark-50 outline-none focus:border-dark-300"
          />
        </label>
        <label className="mt-3 block text-xs text-dark-300">
          Password
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-lg border border-dark-600 bg-dark-900 px-3 py-2 text-sm text-dark-50 outline-none focus:border-dark-300"
          />
        </label>
        {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="mt-5 w-full rounded-full bg-[#d8ff3e] py-2 text-sm font-semibold text-[#08080a] transition hover:brightness-110 disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  )
}
