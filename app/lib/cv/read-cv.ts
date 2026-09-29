import type { Part } from '@google/genai'
import { generateJson, type GeminiCallOptions } from '../gemini-client'
import { CV_RESPONSE_SCHEMA, CV_SYSTEM_PROMPT, type CvExtract } from './cv-schema'
import { NotACvError, parseCvExtract } from './cv-parse'
import { MAX_CV_BYTES } from './cv-limits'

/**
 * Bytes of a PDF in, a cleaned `CvExtract` out. The model call is injected
 * (`generate`, defaulting to the shared Gemini client) so the whole path — size
 * and format checks, the request it builds, parsing, validation — is checked
 * offline against fakes. Not a `'use server'` file: its caller (cv-actions.ts)
 * does auth first.
 */


export type CvReadResult =
  | { ok: true; cv: CvExtract }
  | { ok: false; error: 'too_big' | 'not_pdf' | 'not_a_cv' | 'unreadable' | 'failed'; message?: string }

type Generate = (options: GeminiCallOptions) => Promise<string>

// A CV is read once, carefully: a slower answer is fine, a second model is
// only worth trying if the first failed fast (a 503 or 404 comes back in a
// second; a stuck request uses up the time the page has).
const TIMEOUT_MS = 45_000
const FALLBACK_BUDGET_MS = 12_000

export function isPdf(bytes: Uint8Array): boolean {
  // "%PDF-", possibly after a few junk bytes some generators leave in front.
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 1024))
  return head.includes('%PDF-')
}

export async function readCvBytes(bytes: Uint8Array, generate: Generate = generateJson): Promise<CvReadResult> {
  if (bytes.byteLength > MAX_CV_BYTES) return { ok: false, error: 'too_big' }
  if (!isPdf(bytes)) return { ok: false, error: 'not_pdf' }

  const contents: Part[] = [
    { inlineData: { mimeType: 'application/pdf', data: Buffer.from(bytes).toString('base64') } },
    { text: 'Read this CV and return it as JSON following the rules.' },
  ]

  let raw: string
  try {
    raw = await generate({
      system: CV_SYSTEM_PROMPT,
      contents,
      schema: CV_RESPONSE_SCHEMA,
      // Extraction, not writing: as close to "copy what's there" as the model
      // gets without the degenerate repetition 0 can cause.
      temperature: 0.1,
      maxOutputTokens: 16384,
      timeoutMs: TIMEOUT_MS,
      attempts: 1,
      fallbackBudgetMs: FALLBACK_BUDGET_MS,
      serviceName: 'CV reader',
      notConfigured: 'Reading CVs is not configured yet — GEMINI_API_KEY is not set.',
      cutOff: 'This CV is too long to read in one go — try a shorter version (2–3 pages).',
    })
  } catch (err) {
    return { ok: false, error: 'failed', message: err instanceof Error ? err.message : undefined }
  }

  let parsed: unknown
  try {
    // The outermost {...}: survives a code fence or a stray sentence around it.
    const text = raw.trim()
    parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
  } catch {
    return { ok: false, error: 'unreadable' }
  }

  try {
    return { ok: true, cv: parseCvExtract(parsed) }
  } catch (err) {
    if (err instanceof NotACvError) return { ok: false, error: 'not_a_cv' }
    return { ok: false, error: 'unreadable' }
  }
}
