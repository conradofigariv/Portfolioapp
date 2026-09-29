import { Type, type Schema } from '@google/genai'

/**
 * What the CV reader hands back: the CV as **cards**, one per thing the owner
 * can switch on or off in the import tray (onboarding step 9). Nothing here is
 * saved — step 10 decides where each card lands (every job becomes a project
 * under an "Experience" section; see CLAUDE.md, "Onboarding with a CV").
 *
 * Deliberately absent: phone, address, ID numbers, date of birth, nationality,
 * marital status. The portfolio is always public, and a CV carries all of
 * those; the schema simply has nowhere to put them, and cv-parse.ts scrubs any
 * that leak into free text anyway. The email is read (the owner confirms it
 * before it's published, in step 10).
 */
export type CvLang = 'es' | 'en'

export type CvJob = {
  company: string
  role: string
  /** As written, dashes normalized: "2021 — 2024", "2023 — Presente". */
  period: string
  location: string
  /** One achievement or responsibility per line, as written. */
  highlights: string[]
  /** Tools/skills tied to this job. */
  tools: string[]
  /** Only numbers the CV states. Never estimated. At most 3 (the card's grid). */
  metrics: { label: string; value: string }[]
}

export type CvExtract = {
  /** The CV's own language — it becomes the portfolio's base language. */
  language: CvLang
  name: string
  /** The CV's title line or current role. */
  headline: string
  /** The CV's profile/summary paragraph, if it has one. */
  summary: string
  experience: CvJob[]
  skills: { category: string; items: string[] }[]
  certifications: { title: string; issuer: string; year: string }[]
  education: { institution: string; degree: string; period: string }[]
  /** Spoken languages ("Inglés — C1"), kept apart so they can become their own skill group. */
  languages: string[]
  contact: { email: string; linkedin: string; website: string }
}

const str = (description: string): Schema => ({ type: Type.STRING, description })
const strList = (description: string, max: number): Schema => ({
  type: Type.ARRAY,
  items: { type: Type.STRING },
  maxItems: String(max),
  description,
})

/**
 * The response schema Gemini is held to. `minItems`/`maxItems` are strings in
 * this SDK (see translate/gemini-translator.ts). Every property is required
 * and may be empty — "" / [] — so a missing section is explicit rather than
 * absent, and cv-parse.ts has one shape to check.
 */
export const CV_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    isCv: { type: Type.BOOLEAN, description: 'false if the document is not a CV/résumé at all' },
    language: { type: Type.STRING, enum: ['es', 'en'] },
    name: str("The person's full name"),
    headline: str('Their title line or current role'),
    summary: str('The profile/summary paragraph, if any'),
    experience: {
      type: Type.ARRAY,
      maxItems: '12',
      items: {
        type: Type.OBJECT,
        properties: {
          company: str('Company or organization'),
          role: str('Job title'),
          period: str('Dates as written'),
          location: str('City/country or "Remote", if written'),
          highlights: strList('One achievement or responsibility per item, as written', 6),
          tools: strList('Tools/skills named for this job', 10),
          metrics: {
            type: Type.ARRAY,
            maxItems: '3',
            items: {
              type: Type.OBJECT,
              properties: { label: str('What was measured, 1–3 words'), value: str('The number exactly as written') },
              required: ['label', 'value'],
              propertyOrdering: ['label', 'value'],
            },
          },
        },
        required: ['company', 'role', 'period', 'location', 'highlights', 'tools', 'metrics'],
        propertyOrdering: ['company', 'role', 'period', 'location', 'highlights', 'tools', 'metrics'],
      },
    },
    skills: {
      type: Type.ARRAY,
      maxItems: '8',
      items: {
        type: Type.OBJECT,
        properties: { category: str('Group name'), items: strList('Skills in the group', 20) },
        required: ['category', 'items'],
        propertyOrdering: ['category', 'items'],
      },
    },
    certifications: {
      type: Type.ARRAY,
      maxItems: '15',
      items: {
        type: Type.OBJECT,
        properties: { title: str('Certification'), issuer: str('Who issued it'), year: str('Year, if written') },
        required: ['title', 'issuer', 'year'],
        propertyOrdering: ['title', 'issuer', 'year'],
      },
    },
    education: {
      type: Type.ARRAY,
      maxItems: '8',
      items: {
        type: Type.OBJECT,
        properties: { institution: str('School/university'), degree: str('Degree or program'), period: str('Dates as written') },
        required: ['institution', 'degree', 'period'],
        propertyOrdering: ['institution', 'degree', 'period'],
      },
    },
    languages: strList('Spoken languages with level, e.g. "English — C1"', 8),
    contact: {
      type: Type.OBJECT,
      properties: { email: str('Email, if written'), linkedin: str('LinkedIn URL, if written'), website: str('Personal website, if written') },
      required: ['email', 'linkedin', 'website'],
      propertyOrdering: ['email', 'linkedin', 'website'],
    },
  },
  required: ['isCv', 'language', 'name', 'headline', 'summary', 'experience', 'skills', 'certifications', 'education', 'languages', 'contact'],
  propertyOrdering: ['isCv', 'language', 'name', 'headline', 'summary', 'experience', 'skills', 'certifications', 'education', 'languages', 'contact'],
}

/**
 * The instructions. The rules that matter most are the ones that protect the
 * owner: nothing invented (numbers above all — a made-up "+30%" on a public
 * page is worse than no metric), and nothing private copied over.
 */
export const CV_SYSTEM_PROMPT = `You read a CV/résumé (attached as a PDF) and return its content as JSON matching the schema. The result becomes the first draft of the person's public portfolio, which they will review.

Rules:
1. Copy, don't write. Use the CV's own wording and its own language. Only clean up formatting: remove bullet symbols, join words broken across lines, fix obvious spacing. Never add content, adjectives or claims that are not in the CV.
2. Never invent or estimate numbers. A metric exists only when the CV itself states a number tied to a result (e.g. "reduced churn by 18%" → label "Churn", value "−18%"). Keep the value exactly as written. If there is none, metrics is []. At most 3 per job.
3. Never include private data anywhere, in any field: phone numbers, street address, ID/passport/tax numbers, date of birth, age, nationality, marital status, photo descriptions, references' contact details. The email, a LinkedIn URL and a personal website go only in "contact".
4. experience: one item per job, most recent first. "highlights": one achievement or responsibility per item, at most 6 per job, the most concrete ones first. "tools": tools, technologies or methods the CV names for that job. "period": as written, with " — " between the dates (e.g. "2021 — 2024", "2023 — Presente").
5. headline: the CV's title line (e.g. "Product Manager") or, if there is none, the current role. summary: the CV's own profile/summary paragraph, shortened to at most 300 characters by cutting, not rewriting; "" if there is none.
6. skills: group them as the CV does; if it doesn't, use short sensible groups in the CV's language (e.g. "Herramientas", "Metodologías"). Spoken languages go in "languages", not in skills.
7. language: "es" if the CV is written in Spanish, "en" if in English (if mixed, the language of most of the text).
8. If the document is not a CV/résumé, set isCv to false and leave everything else empty.
Return every property; use "" or [] when the CV has nothing for it.`
