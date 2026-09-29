import type { CvExtract, CvJob, CvLang } from './cv-schema'

/**
 * Validates and cleans the model's answer into a `CvExtract`. The schema holds
 * the model to a *shape*; it can't hold it to the rules, so the ones that
 * protect the owner are enforced again here, on the data:
 *
 * - **No private data**: any phone number or street-address-looking fragment
 *   that slipped into free text is cut out, and a line that is *only* that is
 *   dropped. (The schema has no field for them; this catches leaks.)
 * - **No invented numbers**: a metric whose value has no digit is dropped.
 * - Everything is trimmed, length-capped, de-duplicated and emptied items are
 *   removed, so the import tray never shows an empty card.
 *
 * Pure: no I/O, so every rule is checked offline.
 */

export class NotACvError extends Error {
  constructor() {
    super('not_a_cv')
  }
}

const LIMIT = { short: 120, line: 300, summary: 400 }

// Phone numbers: 8+ digits in a run, allowing spaces, dots, dashes and
// parentheses between them, optionally led by "+". Years ("2021 — 2024") and
// short figures ("18%", "+40") never reach 8 digits in a row.
const PHONE = /(?:\+\s?)?(?:\(?\d[\d\s().-]{6,}\d)/g
// "Av. Corrientes 1234", "Calle Falsa 123", "123 Main St" — street + number.
const STREET = /\b(?:av(?:enida|\.)?|calle|c\/|pasaje|pje\.?|street|st\.|avenue|ave\.?|road|rd\.)\s+[\p{L}\s.]{2,40}\s\d{1,5}\b|\b\d{1,5}\s+[\p{L}\s]{2,30}\s(?:street|st\.?|avenue|ave\.?|road|rd\.?)\b/giu
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function digitCount(s: string): number {
  return (s.match(/\d/g) ?? []).length
}

// Runs of digits that are *not* phone numbers and must survive: a year range
// ("2019-2021", "2019 - 2021") and a thousands-grouped amount ("10.000.000",
// "1,250,000").
const YEAR_RANGE = /^(19|20)\d{2}\s*[-–]\s*(19|20)\d{2}$/
const AMOUNT = /^\d{1,3}([.,]\d{3})+$/

function isPhone(match: string): boolean {
  const m = match.trim()
  const digits = digitCount(m)
  return digits >= 8 && digits <= 15 && !YEAR_RANGE.test(m) && !AMOUNT.test(m)
}

/** Cut phone/address fragments out of free text. */
// The label a CV puts in front of a phone ("Tel:", "Celular", "WhatsApp") —
// removed together with the number, or a lone "Tel" is left behind.
const PHONE_LABEL = /(?:tel(?:[eé]fono)?|phone|cel(?:ular)?|m[oó]vil|mobile|whats ?app)\.?\s*:?\s*$/i

export function scrubPrivate(text: string): string {
  let removed = false
  let out = text.replace(PHONE, (m, offset: number, whole: string) => {
    if (!isPhone(m)) return m
    removed = true
    return m
      ? `\u0000${whole.slice(0, offset).match(PHONE_LABEL)?.[0].length ?? 0}\u0000`
      : m
  })
  // Second pass: each marker carries how many characters of label precede it,
  // so the label goes with the number.
  out = out.replace(/([\s\S]*?)\u0000(\d+)\u0000/g, (_m, before: string, n: string) =>
    before.slice(0, before.length - Number(n))
  )
  out = out.replace(STREET, () => {
    removed = true
    return ''
  })
  out = out
    // "Ana · Tel: … · ana@mail.com" leaves two separators side by side.
    .replace(/\s*([·|,;])(?:\s*[·|,;])+\s*/g, (_m, c: string) => (c === ',' || c === ';' ? `${c} ` : ` ${c} `))
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .trim()
  // Only tidy the edges when something was cut out — otherwise a leading "-"
  // or "−" is part of the text ("-18%" is not "18%").
  return removed ? out.replace(/^[\s,.;:·–—-]+|[\s,;:·–—-]+$/g, '').trim() : out
}

function clean(value: unknown, max: number, scrub = true): string {
  if (typeof value !== 'string') return ''
  // A bullet symbol goes; a middle dot only at the start of a line — in the
  // middle it's a separator the CV means ("Product Manager · Fintech").
  const flat = value
    .replace(/^\s*[•▪●◦·]\s*/, '')
    .replace(/\s*[•▪●◦]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const s = scrub ? scrubPrivate(flat) : flat
  return s.length > max ? s.slice(0, max).replace(/\s+\S*$/, '') + '…' : s
}

function cleanList(value: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of value) {
    const s = clean(item, maxLen)
    const key = s.toLowerCase()
    if (!s || seen.has(key)) continue
    seen.add(key)
    out.push(s)
    if (out.length >= maxItems) break
  }
  return out
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function normalizePeriod(value: unknown): string {
  // Dates only — nothing to scrub, and a scrub could only damage them.
  return clean(value, LIMIT.short, false).replace(/\s*[–—-]\s*/g, ' — ')
}

function job(raw: unknown): CvJob | null {
  const j = obj(raw)
  const company = clean(j.company, LIMIT.short)
  const role = clean(j.role, LIMIT.short)
  if (!company && !role) return null
  const metrics = (Array.isArray(j.metrics) ? j.metrics : [])
    .map((m) => {
      const o = obj(m)
      return { label: clean(o.label, 40), value: clean(o.value, 20) }
    })
    // Rule 2 of the prompt, enforced: a value with no digit isn't a number
    // the CV stated, it's something the model made up or paraphrased.
    .filter((m) => m.label && /\d/.test(m.value))
    .slice(0, 3)
  return {
    company,
    role,
    period: normalizePeriod(j.period),
    location: clean(j.location, LIMIT.short),
    highlights: cleanList(j.highlights, 6, LIMIT.line),
    tools: cleanList(j.tools, 10, 40),
    metrics,
  }
}

export function parseCvExtract(raw: unknown): CvExtract {
  const r = obj(raw)
  if (r.isCv === false) throw new NotACvError()

  const language: CvLang = r.language === 'en' ? 'en' : 'es'
  const experience = (Array.isArray(r.experience) ? r.experience : [])
    .map(job)
    .filter((j): j is CvJob => j !== null)
    .slice(0, 12)
  const skills = (Array.isArray(r.skills) ? r.skills : [])
    .map((s) => {
      const o = obj(s)
      return { category: clean(o.category, 60), items: cleanList(o.items, 20, 40) }
    })
    .filter((s) => s.items.length > 0)
    .slice(0, 8)
  const certifications = (Array.isArray(r.certifications) ? r.certifications : [])
    .map((c) => {
      const o = obj(c)
      return { title: clean(o.title, LIMIT.short), issuer: clean(o.issuer, LIMIT.short), year: clean(o.year, 12) }
    })
    .filter((c) => c.title)
    .slice(0, 15)
  const education = (Array.isArray(r.education) ? r.education : [])
    .map((e) => {
      const o = obj(e)
      return {
        institution: clean(o.institution, LIMIT.short),
        degree: clean(o.degree, LIMIT.short),
        period: normalizePeriod(o.period),
      }
    })
    .filter((e) => e.institution || e.degree)
    .slice(0, 8)

  const contact = obj(r.contact)
  const email = typeof contact.email === 'string' ? contact.email.trim() : ''
  const linkedin = typeof contact.linkedin === 'string' ? contact.linkedin.trim() : ''
  const website = typeof contact.website === 'string' ? contact.website.trim() : ''

  const result: CvExtract = {
    language,
    name: clean(r.name, LIMIT.short),
    headline: clean(r.headline, LIMIT.line),
    summary: clean(r.summary, LIMIT.summary),
    experience,
    skills,
    certifications,
    education,
    languages: cleanList(r.languages, 8, 60),
    contact: {
      email: EMAIL_RE.test(email) && email.length <= 120 ? email : '',
      linkedin: /^(https?:\/\/)?([\w-]+\.)?linkedin\.com\//i.test(linkedin) ? linkedin.slice(0, 200) : '',
      website: /^(https?:\/\/)?[\w-]+(\.[\w-]+)+/i.test(website) && !/linkedin\.com/i.test(website) ? website.slice(0, 200) : '',
    },
  }

  // A "CV" with nothing usable is treated like a document that isn't one:
  // there'd be nothing to put in the tray.
  if (!result.name && !result.headline && result.experience.length === 0 && result.skills.length === 0) {
    throw new NotACvError()
  }
  return result
}
