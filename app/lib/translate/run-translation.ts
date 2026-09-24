import type { ChunkFailure } from './translate-batch'
import type { TranslateChunkResult } from './translate-actions'

/**
 * The client-side driver for a translation run: call for a chunk, report
 * progress, decide whether to ask for another.
 *
 * Split out of `TranslatePanel` and given its chunk function as an argument
 * for the same reason `translateBatch` takes its translator that way — it puts
 * the one piece of real decision-making in this feature's client half somewhere
 * it can be driven by a fake and checked offline, instead of only through a UI
 * that needs a live Supabase session and real model calls to reach at all.
 *
 * **One failing batch never blocks the rest.** A field that fails is added to
 * `skip` for the remainder of the run (see `translateChunk`), so every chunk
 * works on fields this run hasn't tried yet and the plan shrinks by a full
 * batch each time, whatever the outcome. That's what bounds the loop — it
 * can't revisit a field — rather than an iteration cap. The earlier version
 * stopped the whole run the moment one chunk wrote nothing, and since the plan
 * is sorted the same way every time, that was always the *same* first 6
 * fields: a real run reported "0 of 124" on every click, with 118 fields that
 * were never even attempted.
 */

export type ChunkFn = (limit: number, skip: string[]) => Promise<TranslateChunkResult>
type ChunkOk = Extract<TranslateChunkResult, { ok: true }>
type FieldFailure = ChunkFailure

export type RunOutcome =
  /** Every planned field was written. */
  | { status: 'done'; translated: number }
  /** The run reached the end of the plan, but these fields didn't make it. */
  | { status: 'partial'; translated: number; failures: FieldFailure[] }
  /** `shouldStop` returned true between chunks. */
  | { status: 'stopped'; translated: number; failures: FieldFailure[] }
  /**
   * The action refused outright (auth, config, a Postgres error), or the model
   * service failed on too many chunks in a row to be worth continuing.
   * `translated` is what was saved before that.
   */
  | { status: 'error'; translated: number; error: string; failures: FieldFailure[] }

/**
 * How many chunks in a row may have their *whole* model call fail before the
 * run gives up for now. One is a blip worth moving past (the next batch goes to
 * the same service a few seconds later and often gets through); two in a row —
 * each already having tried every fallback model — means the service is down,
 * and ploughing through the remaining chunks would only produce a longer list
 * of the same error.
 */
const MAX_CONSECUTIVE_CALL_ERRORS = 2

export async function runTranslation(options: {
  chunk: ChunkFn
  limit: number
  /**
   * Checked *between* chunks only — a server action already in flight can't be
   * cancelled, and whatever it wrote is saved either way, so there is nothing
   * to unwind. Stopping is always safe and never loses work.
   */
  shouldStop: () => boolean
  /** `total` is re-read from the server every chunk, so it self-corrects. */
  onProgress: (translated: number, total: number) => void
  /** Every successful chunk, as it lands — for the live feed of what changed. */
  onChunk?: (result: ChunkOk) => void
  /**
   * Also skip fields that *succeeded* — for a review run, where nothing is
   * written, so a translated field never leaves the plan on its own and would
   * otherwise be picked again by the next chunk forever.
   */
  skipSucceeded?: boolean
}): Promise<RunOutcome> {
  const { chunk, limit, shouldStop, onProgress, onChunk, skipSucceeded = false } = options
  const succeeded = new Set<string>()
  let translated = 0
  // Keyed by block_key so a field can never be listed twice.
  const failed = new Map<string, FieldFailure>()
  const failures = () => [...failed.values()]
  let callErrorsInARow = 0

  for (;;) {
    if (shouldStop()) return { status: 'stopped', translated, failures: failures() }

    const result = await chunk(limit, [...failed.keys(), ...succeeded])
    if (!result.ok) return { status: 'error', translated, error: result.error, failures: failures() }

    translated += result.translated
    if (skipSucceeded) for (const item of result.written) succeeded.add(item.blockKey)
    onChunk?.(result)
    for (const failure of result.failures) failed.set(failure.blockKey, failure)
    // `remaining` is recomputed from a fresh plan each chunk, so the total
    // stays right even if the portfolio changed underneath mid-run, rather
    // than counting down from a figure captured once at the start.
    onProgress(translated, translated + failed.size + result.remaining)

    if (result.done) {
      return failed.size === 0
        ? { status: 'done', translated }
        : { status: 'partial', translated, failures: failures() }
    }

    callErrorsInARow = result.callError ? callErrorsInARow + 1 : 0
    if (callErrorsInARow >= MAX_CONSECUTIVE_CALL_ERRORS) {
      return { status: 'error', translated, error: result.callError as string, failures: failures() }
    }

    // Can't happen with a well-behaved server (a non-empty plan always yields
    // a non-empty batch), but it's the one way this loop could spin without
    // the plan shrinking, so it's guarded rather than assumed.
    if (result.attempted === 0) {
      return { status: 'partial', translated, failures: failures() }
    }
  }
}
