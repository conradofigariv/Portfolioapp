import type { FieldFailure } from './translate-batch'
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
 * The loop deliberately has no iteration cap. Its two exits (`done` when the
 * plan empties, and a chunk that moved nothing) are what bound it; a counter on
 * top would only ever fire once one of those is already broken, and would hide
 * that rather than surface it.
 */

export type ChunkFn = (limit: number) => Promise<TranslateChunkResult>

export type RunOutcome =
  /** The plan emptied — everything asked for was written. */
  | { status: 'done'; translated: number }
  /** A whole chunk moved nothing. See below for why that's the stop signal. */
  | { status: 'stalled'; translated: number; failures: FieldFailure[] }
  /** `shouldStop` returned true between chunks. */
  | { status: 'stopped'; translated: number }
  /** The action itself refused (auth, config, a Postgres error). */
  | { status: 'error'; translated: number; error: string }

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
}): Promise<RunOutcome> {
  const { chunk, limit, shouldStop, onProgress } = options
  let translated = 0

  for (;;) {
    if (shouldStop()) return { status: 'stopped', translated }

    const result = await chunk(limit)
    if (!result.ok) return { status: 'error', translated, error: result.error }

    translated += result.translated
    // The server's `remaining` is recomputed from a fresh plan each chunk, so
    // "what's left" stays right even if the portfolio changed underneath —
    // rather than counting down from a total captured once at the start.
    onProgress(translated, translated + result.remaining)

    if (result.done) return { status: 'done', translated }

    // A failed field deliberately leaves its target row untouched, so it comes
    // back as `missing` on the next plan. That is what makes a *transient*
    // failure self-healing — and what would make a *permanent* one (a model
    // that keeps answering one field in the wrong shape) loop forever. A single
    // chunk cannot tell those apart; a whole chunk moving nothing can.
    if (result.translated === 0) {
      return { status: 'stalled', translated, failures: result.failures }
    }
  }
}
