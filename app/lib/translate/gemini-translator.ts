import { Type, type Schema } from '@google/genai'
import { generateJson } from '../gemini-client'
import type { Translator } from './translate-batch'
import type { TranslationShape } from './prompt'

/**
 * The translator `translateBatch` is handed in production: one structured
 * Gemini call per batch, through the shared client (../gemini-client.ts —
 * model chain, timeouts, retries and error messages live there).
 *
 * Not a `'use server'` file, for the same reason as the client: its only
 * importer is `translate-actions.ts`, which does the auth checks first.
 */

// Generous on purpose. A batch's answer is a handful of short strings, but on
// this family the model's own reasoning tokens can count against this ceiling
// too, and hitting it truncates the JSON mid-object.
const MAX_OUTPUT_TOKENS = 16384

// Translation is a faithful transformation, not a creative one: the default
// sampling temperature on this family is high enough to invite small
// re-phrasings, which is exactly what rule 3 of the prompt asks against. Not 0
// — that can push some models into degenerate repetition.
const TEMPERATURE = 0.2

// Per request. Short enough that a stuck model still leaves time to try the
// next one inside the page's `maxDuration` (60s, app/[username]/page.tsx).
const TIMEOUT_MS = 25_000

// No new model is started once this much of the function's time is gone: one
// more attempt that the platform cuts off halfway helps nobody, and the chunk
// loop will simply try this batch's fields again on the owner's next run.
const FALLBACK_BUDGET_MS = 30_000

// One real retry per model: a blip is smoothed over, and a model still failing
// after that is having a sustained outage, which the *next model* is far more
// likely to get past than a third attempt on the same one.
const ATTEMPTS = 2

/**
 * The per-batch response schema: one property per field id, each an array of
 * exactly as many strings as that field has fragments.
 *
 * This is what makes the one-entry-per-fragment contract structurally
 * impossible to break, rather than something the prompt asks for and
 * `translate-batch.ts` then has to catch. That validation stays regardless —
 * a schema constrains the *shape* of the answer, never its correctness.
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

export function createGeminiTranslator(): Translator {
  return ({ system, user, shape }) =>
    generateJson({
      system,
      contents: user,
      schema: responseSchema(shape),
      temperature: TEMPERATURE,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      timeoutMs: TIMEOUT_MS,
      attempts: ATTEMPTS,
      fallbackBudgetMs: FALLBACK_BUDGET_MS,
      serviceName: 'translation service',
      notConfigured: 'Translation is not configured yet — GEMINI_API_KEY is not set.',
      cutOff: 'The translation was cut off — try again with fewer fields at a time.',
    })
}
