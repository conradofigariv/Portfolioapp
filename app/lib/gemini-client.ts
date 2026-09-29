import { GoogleGenAI, ApiError, type Part, type Schema } from '@google/genai'

/**
 * The one place that actually talks to Gemini — shared by the translator
 * (translate/gemini-translator.ts) and the CV reader (cv/cv-actions.ts).
 *
 * **Server-only, and deliberately not a server action.** It must not live in a
 * `'use server'` file: every exported async function there becomes a callable
 * endpoint, and this one spends tokens — exposing it would hand anyone on the
 * internet a free, unmetered model call. Its callers do the auth checks first.
 * (`GEMINI_API_KEY` has no `NEXT_PUBLIC_` prefix, so Next replaces it with
 * `undefined` in any client bundle — the key itself can't leak even if this
 * were imported by mistake; what's being guarded here is the *call*.)
 *
 * What lives here was learned on the translation feature (see CLAUDE.md, "AI
 * translation", step 4): the model id is an env var with a default, a
 * fallback chain across models, explicit timeouts and retries sized for a
 * serverless function, and every error mapped to something actionable.
 */

/**
 * The model lineup moves faster than any hard-coded default survives, so this
 * is an env var with a default rather than a constant. Note that the older 2.5
 * line is only served to keys that already used it, so a fresh key pointed at
 * `gemini-2.5-flash` would simply 404. See `describe()` for how a wrong id
 * surfaces.
 */
const DEFAULT_MODEL = 'gemini-3.8-flash'

/**
 * Tried in order when the one before it is unavailable (see `fallsThrough`).
 * Surfaced live: the default model answered `503 UNAVAILABLE` on every attempt
 * for a while; a different model in the same family almost never shares that
 * outage. Whatever `GEMINI_MODEL` names always goes first; de-duplicated.
 */
const FALLBACK_MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite']

/** The API's own error text, out of the JSON body the SDK puts in `message`. */
function apiMessage(err: ApiError): string {
  const raw = err.message ?? ''
  try {
    const body = JSON.parse(raw.slice(raw.indexOf('{')))
    if (typeof body?.error?.message === 'string') return body.error.message
  } catch {
    // Not JSON: the message is the text.
  }
  return raw
}

/**
 * Worth trying another model: this one doesn't exist for this key (404), is
 * rate-limited (429), is out of capacity or broken (5xx), never answered at
 * all (a timeout or a dropped connection) — or rejected the request (400).
 *
 * A 400 used to stop the chain ("the same bad request on every model"), until
 * a live CV import came back `[gemini-3.8-flash: 503 · gemini-3.6-flash: 400]`:
 * a request one model accepts, another can refuse (a response schema too
 * complex for a smaller model), so the next model is worth its one request.
 * Only a key problem is the same everywhere: 401/403, and a 400 that says the
 * API key is invalid.
 */
function fallsThrough(err: unknown): boolean {
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 403) return false
    if (err.status === 400) return !/api key/i.test(apiMessage(err))
    return err.status === 404 || err.status === 429 || err.status >= 500
  }
  return true
}

/** One model's outcome for the error's detail: the code, plus the API's reason when it's a rejection. */
function outcome(err: unknown): string {
  if (!(err instanceof ApiError)) return 'no answer'
  if (err.status === 429 || err.status >= 500) return String(err.status)
  const reason = apiMessage(err).replace(/\s+/g, ' ').trim()
  return reason ? `${err.status} ${reason.length > 90 ? reason.slice(0, 90) + '…' : reason}` : String(err.status)
}

export type GeminiCallOptions = {
  system: string
  /** A plain prompt, or parts (e.g. an inline PDF plus an instruction). */
  contents: string | Part[]
  schema: Schema
  temperature: number
  maxOutputTokens: number
  /** Per request. Has to leave room inside the page's `maxDuration` (60s). */
  timeoutMs: number
  /** SDK retries per model: the SDK's own default (5, up to 60s apart) outlasts a serverless function. */
  attempts: number
  /** No new fallback model is started once this much time has gone by. */
  fallbackBudgetMs: number
  /** How messages name this feature: "translation service", "CV reader". */
  serviceName: string
  /** The message when GEMINI_API_KEY is missing — a setup problem, not an auth failure. */
  notConfigured: string
  /**
   * The message when the answer hit `maxOutputTokens` — which truncates the
   * JSON mid-object, so it would otherwise arrive as an unparseable answer
   * rather than as its real cause. Worded as the fix ("fewer fields").
   */
  cutOff: string
}

/**
 * Turns the SDK's errors into something the owner can act on — "your key is
 * wrong" has to be distinguishable from "rate limited, wait a moment", since
 * one is worth retrying and the other never is. A 503's own body is a raw
 * JSON blob (surfaced live in the translation failure list), so it gets a
 * friendly message of its own.
 */
function describe(err: unknown, model: string, service: string): string {
  const Service = service.charAt(0).toUpperCase() + service.slice(1)
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 403) return `The ${service} rejected the API key. Check GEMINI_API_KEY.`
    if (err.status === 404) return `The ${service} has no model called "${model}". Set GEMINI_MODEL to a current one.`
    if (err.status === 429) return `The ${service} is rate limiting us — wait a moment and continue.`
    if (err.status === 503) return `The ${service} is overloaded right now — wait a moment and try again.`
    if (err.status >= 500) return `The ${service} had an internal error — try again in a moment.`
    return `${Service} failed (${err.status}): ${err.message}`
  }
  return err instanceof Error ? err.message : `The ${service} call failed.`
}

/** One structured (JSON) call, across the fallback chain. Returns the raw JSON text. */
export async function generateJson(options: GeminiCallOptions): Promise<string> {
  // Checked here rather than letting the SDK throw, so a missing key reads as
  // a setup problem ("set this variable") instead of an auth failure.
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error(options.notConfigured)

  const primary = process.env.GEMINI_MODEL || DEFAULT_MODEL
  const models = [...new Set([primary, ...FALLBACK_MODELS])]
  const client = new GoogleGenAI({
    apiKey,
    httpOptions: {
      timeout: options.timeoutMs,
      retryOptions: { attempts: options.attempts, initialDelay: 1, maxDelay: 4 },
    },
  })

  const started = Date.now()
  let response
  // The *first* model's error is the one reported if every model fails: it's
  // the one the owner configured, so a 404 there still names the right
  // variable to fix even when a fallback 503'd.
  let firstError: { err: unknown; model: string } | null = null
  // What happened on each model, appended to the final error: the sandbox this
  // app is built in can't reach Gemini, so a screenshot of that message is the
  // only way to tell "every model is overloaded" from "only one was tried".
  const tried: string[] = []
  for (const model of models) {
    if (firstError && Date.now() - started > options.fallbackBudgetMs) {
      tried.push(`${model}: skipped`)
      continue
    }
    try {
      response = await client.models.generateContent({
        model,
        contents: options.contents,
        config: {
          systemInstruction: options.system,
          temperature: options.temperature,
          maxOutputTokens: options.maxOutputTokens,
          responseMimeType: 'application/json',
          responseSchema: options.schema,
          // `thinkingConfig` is deliberately left unset: a model that requires
          // reasoning rejects a request that turns it off, and this app can't
          // tell which is which against the real API from its own sandbox.
        },
      })
      break
    } catch (err) {
      firstError ??= { err, model }
      tried.push(`${model}: ${outcome(err)}`)
      if (!fallsThrough(err)) break
    }
  }
  if (!response) {
    const message = firstError
      ? describe(firstError.err, firstError.model, options.serviceName)
      : `The ${options.serviceName} call failed.`
    throw new Error(`${message} [${tried.join(' · ')}]`)
  }

  // A blocked prompt comes back as an ordinary success with no candidate at
  // all, so this has to be checked before anything reads the text.
  const blocked = response.promptFeedback?.blockReason
  if (blocked) throw new Error(`The model declined this request (${blocked}). Nothing was changed.`)

  const finish = response.candidates?.[0]?.finishReason
  if (finish === 'MAX_TOKENS') throw new Error(options.cutOff)
  if (finish && finish !== 'STOP') {
    // SAFETY, RECITATION, and anything the SDK adds later — named, since the
    // category is the only clue about why a request keeps failing.
    throw new Error(`The model stopped early (${finish}). Nothing was changed.`)
  }

  const text = response.text
  if (!text || !text.trim()) throw new Error('The model returned an empty response.')
  return text
}
