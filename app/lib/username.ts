// Turns a Google display name or email into a candidate username matching the
// database constraint: ^[a-z0-9][a-z0-9-]{2,29}$ (3-30 chars, starts alphanumeric).
export function slugifyUsername(input: string): string {
  const accentsStripped = input.normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
  const base = accentsStripped
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)

  return base.length >= 3 ? base : `user-${base}`.slice(0, 30)
}

export function withSuffix(base: string, attempt: number): string {
  if (attempt === 0) return base
  const suffix = `-${attempt + 1}`
  return `${base.slice(0, 30 - suffix.length)}${suffix}`
}

// The database's own rules for an address (profiles' CHECK constraints in
// 0001), mirrored here so the picker can say what's wrong while typing
// instead of after a round trip. change_username() checks again regardless.
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9-]{2,29}$/

// Same list as public.is_reserved_username() in 0001 — addresses that would
// collide with an app route. Keep the two in sync.
const RESERVED = new Set([
  'admin', 'api', 'app', 'auth', 'login', 'logout', 'signup', 'signin',
  'portfolio-app', 'settings', 'dashboard', 'new', 'edit', 'about',
  'privacy', 'terms', 'support', 'help', 'static', 'public', 'assets',
  'images', 'videos', 'favicon', 'robots', 'sitemap', 'www', 'root',
])

export function isReservedUsername(name: string): boolean {
  return RESERVED.has(name)
}

// What the picker's input turns typing into: lowercase, no accents, spaces
// and anything else become a single "-". Unlike slugifyUsername it keeps a
// trailing "-" (someone mid-way through typing "ana-") and doesn't pad a
// short value — the pattern check reports those instead.
export function normalizeUsernameInput(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 30)
}

export type UsernameProblem = 'invalid' | 'reserved' | null

export function usernameProblem(name: string): UsernameProblem {
  if (!USERNAME_PATTERN.test(name) || name.endsWith('-')) return 'invalid'
  if (isReservedUsername(name)) return 'reserved'
  return null
}
