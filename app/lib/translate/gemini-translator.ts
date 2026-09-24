import { GoogleGenAI, Type, ApiError, type Schema } from '@google/genai'
import type { Translator } from './translate-batch'
import type { TranslationShape } from './prompt'

/**
 * The one place that actually talks to a model.
 *
 * **Server-only, and deliberately not a server action.** It must not live in a
 * `'use server'` file: every exported async function there becomes a callable
 * endpoint, and this one takes a prompt and spends tokens — exposing it would
 * hand anyone on the internet a free, unmetered model call. Its only importer
 * is `translate-actions.ts`, which does the auth and portfolio checks first.
 * (`GEMINI_API_KEY` has no `NEXT_PUBLIC_` prefix, so Next replaces it with
 * `undefined` in any client bundle — the key itself can't leak even if this
 * were imported by mistake; what's being guarded here is the *call*.)
 */

/**
 * The model lineup moves faster than any hard-coded default survives, so this
 * is an env var with a default rather than a constant: a model ID that stops
 * being served becomes a one-variable change instead of a code change. The
 * default is the current recommendation for a *new* project — note that the
 * older 2.5 line is only served to keys that already used it, so a fresh key
 * pointed at `gemini-2.5-flash` would simply 404. See `describe()` for how a
 * wrong ID surfaces.
 */
const DEFAULT_MODEL = 'gemini-3.8-flash'

// Generous on purpose. A batch's answer is a handful of short strings, but on
// this family the model's own reasoning tokens can count against this ceiling
// too, and hitting it truncates the JSON mid-object — which would arrive as an
// unparseable answer rather than as the real cause. See the MAX_TOKENS branch.
const MAX_OUTPUT_TOKENS = 16384

// Translation is a faithful transformation, not a creative one: the default
// sampling temperature on this family is high enough to invite small
// re-phrasings, which is exactly what rule 3 of the prompt asks against. Not 0
// — that can push some models into degenerate repetition.
const TEMPERATURE = 0.2

/**
 * Tried in order when the one before it is unavailable (see `fallsThrough`).
 *
 * Surfaced live: a real run hit `503 UNAVAILABLE` ("high demand") on the
 * default model on every single attempt, across several clicks of "try again"
 * — that model was simply out of capacity for a while, and nothing about
 * retrying *it* was ever going to help. A different model in the same family
 * almost never shares that outage, and for this task (short strings, same
 * count back, schema-enforced) any of them does the job. Whatever
 * `GEMINI_MODEL` names always goes first; the defaults follow, de-duplicated.
 */
const FALLBACK_MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite']

// Per request. Short enough that a stuck model still leaves time to try the
// next one inside the page's `maxDuration` (60s, app/[username]/page.tsx) —
// the SDK default would outlast the whole function, and the platform would
// kill it before the owner ever saw one of the real messages below.
const TIMEOUT_MS = 25_000

// No new model is started once this much of the function's time is gone: one
// more attempt that the platform cuts off halfway helps nobody, and the chunk
// loop will simply try this batch's fields again on the owner's next run.
const FALLBACK_BUDGET_MS = 30_000

/**
 * The SDK's own default retry budget (5 attempts, exponential backoff up to a
 * 60s cap per step) is tuned for a long-running batch job, not a single call
 * inside a serverless function with its own wall-clock limit. Kept to one real
 * retry per model: a blip is smoothed over, and a model that is still failing
 * after that is having a sustained outage, which the *next model* in
 * `FALLBACK_MODELS` is far more likely to get past than a third attempt on the
 * same one.
 */
const RETRY_OPTIONS = { attempts: 2, initialDelay: 1, maxDelay: 4 }

/**
 * Worth trying another model: this one doesn't exist for this key (404), is
 * rate-limited (429), is out of capacity or broken (5xx), or never answered
 * at all (a timeout or a dropped connection). *Not* a 400/401/403 — a bad
 * request or a bad key is the same bad key on every model, and falling through
 * would only turn one clear message into three identical failures.
 */
function fallsThrough(err: unknown): boolean {
  if (err instanceof ApiError) return err.status === 404 || err.status === 429 || err.status >= 500
  return true
}

/**
 * The per-batch response schema: one property per field id, each an array of
 * exactly as many strings as that field has fragments.
 *
 * This is what makes the one-entry-per-fragment contract structurally
 * impossible to break, rather than something the prompt asks for and
 * `translate-batch.ts` then has to catch. That validation stays regardless —
 * a schema constrains the *shape* of the answer, never its correctness, and
 * this app can't reach the real API from its own sandbox to confirm the
 * constraint is honoured on every path.
 *
 * **`minItems`/`maxItems` are strings in this SDK**, not numbers — they map to
 * the proto's int64 fields, which serialize as strings. Passing a number is a
 * type error, and passing one through `as never` would silently drop the
 * bound.
 */
function responseSchema(shape: TranslationShape): Schema {
  const properties: Record<string, Schema> = {}
  for (const field of shape) {
    properties[field.id] = {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      minItems: String(field.count),
      maxItems: String(field.count),
    }
  }
  const ids = shape.map((field) => field.id)
  return { type: Type.OBJECT, properties, required: ids, propertyOrdering: ids }
}

/**
 * Turns the SDK's errors into something the owner can act on. These messages
 * travel all the way to the progress UI, so "your key is wrong" has to be
 * distinguishable from "rate limited, wait a moment" — one is worth retrying
 * and the other never is.
 */
function describe(err: unknown, model: string): string {
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 403) {
      return 'The translation service rejected the API key. Check GEMINI_API_KEY.'
    }
    if (err.status === 404) {
      return `The translation service has no model called "${model}". Set GEMINI_MODEL to a current one.`
    }
    if (err.status === 429) {
      return 'The translation service is rate limiting us — wait a moment and continue.'
    }
    if (err.status === 503) {
      // What Google's own message actually says here ("high demand... try
      // again later") is already the right advice, but it arrives as a raw
      // JSON error body — surfaced live in the owner's own failure list as an
      // ugly `{"error":{"code":503,...}}` blob. This is the friendly version.
      return 'The translation service is overloaded right now — wait a moment and try again.'
    }
    if (err.status >= 500) {
      return 'The translation service had an internal error — try again in a moment.'
    }
    return `The translation service failed (${err.status}): ${err.message}`
  }
  return err instanceof Error ? err.message : 'The translation call failed.'
}

export function createGeminiTranslator(): Translator {
  return async ({ system, user, shape }) => {
    // Checked here rather than letting the SDK throw, so a missing key reads as
    // a setup problem ("set this variable") instead of an auth failure.
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      throw new Error('Translation is not configured yet — GEMINI_API_KEY is not set.')
    }
    const primary = process.env.GEMINI_MODEL || DEFAULT_MODEL
    const models = [...new Set([primary, ...FALLBACK_MODELS])]
    const client = new GoogleGenAI({
      apiKey,
      httpOptions: { timeout: TIMEOUT_MS, retryOptions: RETRY_OPTIONS },
    })

    const started = Date.now()
    let response
    // The *first* model's error is the one reported if every model fails: it's
    // the one the owner configured (or the default they'd look up), so a 404
    // there still names the right variable to fix even when a fallback 503'd.
    let firstError: { err: unknown; model: string } | null = null
    for (const model of models) {
      if (firstError && Date.now() - started > FALLBACK_BUDGET_MS) break
      try {
        response = await client.models.generateContent({
          model,
          contents: user,
          config: {
            systemInstruction: system,
            temperature: TEMPERATURE,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            responseMimeType: 'application/json',
            responseSchema: responseSchema(shape),
            // `thinkingConfig` is deliberately left unset. Turning reasoning off
            // is the obvious latency win, but a model that requires it rejects
            // the request outright, and this app can't verify which is which
            // against the real API from its own sandbox — so the model's own
            // default is the only setting that is safe on every ID someone might
            // put in GEMINI_MODEL (or in the fallback list above).
          },
        })
        break
      } catch (err) {
        firstError ??= { err, model }
        if (!fallsThrough(err)) break
      }
    }
    if (!response) {
      throw new Error(firstError ? describe(firstError.err, firstError.model) : 'The translation call failed.')
    }

    // A blocked prompt comes back as an ordinary success with no candidate at
    // all, so this has to be checked before anything reads the text.
    const blocked = response.promptFeedback?.blockReason
    if (blocked) {
      throw new Error(`The model declined this request (${blocked}). Nothing was changed.`)
    }

    const finish = response.candidates?.[0]?.finishReason
    if (finish === 'MAX_TOKENS') {
      throw new Error('The translation was cut off — try again with fewer fields at a time.')
    }
    if (finish && finish !== 'STOP') {
      // SAFETY, RECITATION, and anything the SDK adds later. Named rather than
      // folded into a generic message, since the category is the only clue the
      // owner gets about why one particular field keeps failing.
      throw new Error(`The model stopped early (${finish}). Nothing was changed.`)
    }

    const text = response.text
    if (!text || !text.trim()) throw new Error('The model returned an empty response.')
    return text
  }
}
