import Anthropic from '@anthropic-ai/sdk'
import type { Translator } from './translate-batch'

/**
 * The one place that actually talks to a model.
 *
 * **Server-only, and deliberately not a server action.** It must not live in a
 * `'use server'` file: every exported async function there becomes a callable
 * endpoint, and this one takes a prompt and spends tokens — exposing it would
 * hand anyone on the internet a free, unmetered model call. Its only importer
 * is `translate-actions.ts`, which does the auth and portfolio checks first.
 * (`ANTHROPIC_API_KEY` has no `NEXT_PUBLIC_` prefix, so Next replaces it with
 * `undefined` in any client bundle — the key itself can't leak even if this
 * were imported by mistake; what's being guarded here is the *call*.)
 */

// claude-opus-5: the current default, not chosen for cost. Translating the text
// someone wrote about their own career is worth the capable model — a cheaper
// one reads as a slightly-off translation, which is exactly the thing the owner
// then has to fix by hand in a language they may not be fluent in.
const MODEL = 'claude-opus-5'

// Non-streaming: one batch's answer is a handful of short strings, nowhere near
// a size that risks an HTTP timeout, and the chunk loop already gives progress
// without needing token-level streaming for it.
const MAX_TOKENS = 16000

// Translation is a routine, well-specified transformation, not a reasoning
// problem — `low` is what this scale of task is for, and it keeps a chunk fast
// enough to finish inside a serverless function's time limit. Thinking is
// deliberately left at its default (adaptive, on): explicitly disabling it on
// this model can make it write a tool call or a stray `<thinking>` tag into the
// visible text, and lowering effort achieves the same cost saving safely.
const EFFORT = 'low' as const

// The SDK's own defaults are a 10-minute timeout and 2 retries, both of which
// outlast the serverless function this runs inside — the platform would kill the
// request first and the owner would see a generic failure instead of one of the
// messages below. Bounded explicitly so *our* error is the one that surfaces,
// and so a rate-limited call doesn't spend the whole chunk's time budget backing
// off (the chunk is resumable; the next click retries it anyway).
const TIMEOUT_MS = 60_000
const MAX_RETRIES = 1

// A policy decline is essentially impossible for "translate this person's
// portfolio", but the fallback costs nothing until it's needed: on a refusal the
// API re-runs the same request on this model inside the same call instead of
// handing back nothing. Kept as a constant because it rides on a beta header —
// see the degradation path in `callModel` for what happens if the beta isn't
// available to this account.
const FALLBACK_BETA = 'server-side-fallback-2026-06-01'
const FALLBACK_MODEL = 'claude-opus-4-8'

/** The model's text, concatenated — a response can be split across blocks. */
function textOf(content: readonly { type: string }[]): string {
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

function assertUsable(stopReason: string | null, content: readonly { type: string }[]): string {
  // stop_reason has to be checked *before* reading content: a refusal comes back
  // as a perfectly ordinary HTTP 200 with nothing usable in it.
  if (stopReason === 'refusal') {
    throw new Error('The model declined this request. Nothing was changed.')
  }
  if (stopReason === 'max_tokens') {
    throw new Error('The translation was cut off — try again with fewer fields at a time.')
  }
  const text = textOf(content)
  if (!text.trim()) throw new Error('The model returned an empty response.')
  return text
}

function isFallbackRejection(err: unknown): boolean {
  if (!(err instanceof Anthropic.BadRequestError)) return false
  const message = err.message.toLowerCase()
  return message.includes('fallback') || message.includes('beta')
}

/**
 * Turns the SDK's typed errors into something the owner can act on. The
 * messages travel all the way to the progress UI, so "rate limited, wait a
 * moment" has to be distinguishable from "your API key is wrong" — one is worth
 * retrying and the other never is.
 */
function describe(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return 'The translation service rejected the API key. Check ANTHROPIC_API_KEY.'
  }
  if (err instanceof Anthropic.RateLimitError) {
    return 'The translation service is rate limiting us — wait a moment and continue.'
  }
  if (err instanceof Anthropic.BadRequestError) {
    return `The translation request was rejected: ${err.message}`
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return 'Could not reach the translation service. Check the connection and continue.'
  }
  if (err instanceof Anthropic.APIError) {
    return `The translation service failed (${err.status}): ${err.message}`
  }
  return err instanceof Error ? err.message : 'The translation call failed.'
}

export function createAnthropicTranslator(): Translator {
  return async ({ system, user }) => {
    // Checked here rather than letting the SDK throw, so a missing key reads as
    // a setup problem ("set this variable") instead of an auth failure.
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('Translation is not configured yet — ANTHROPIC_API_KEY is not set.')
    }
    const client = new Anthropic({ timeout: TIMEOUT_MS, maxRetries: MAX_RETRIES })
    const request = {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      output_config: { effort: EFFORT },
      system,
      messages: [{ role: 'user' as const, content: user }],
    }

    // No `cache_control` here on purpose: the system prompt is stable across
    // every chunk and would look like an obvious thing to cache, but it's a few
    // hundred tokens — well under this model's minimum cacheable prefix — so a
    // breakpoint would silently never hit and only add a misleading line of
    // code. Revisit if the prompt ever grows past that floor.
    try {
      const response = await client.beta.messages.create({
        ...request,
        betas: [FALLBACK_BETA],
        fallbacks: [{ model: FALLBACK_MODEL }],
      })
      return assertUsable(response.stop_reason, response.content)
    } catch (err) {
      // The refusal fallback rides a beta header, and this app can't verify
      // against the real API from its own sandbox. If the account doesn't have
      // that beta, the plain call is exactly as correct — just without the
      // rescue — so degrade rather than failing every translation outright.
      if (isFallbackRejection(err)) {
        try {
          const response = await client.messages.create(request)
          return assertUsable(response.stop_reason, response.content)
        } catch (retryErr) {
          throw new Error(describe(retryErr))
        }
      }
      throw new Error(describe(err))
    }
  }
}
