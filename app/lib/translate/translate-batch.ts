import type { JSONContent } from '@tiptap/core'
import type { Lang } from '../portfolio'
import { applyTextNodes } from './tiptap-text'
import type { PlannedField } from './plan'
import {
  buildTranslationPrompt,
  parseTranslationResponse,
  type TranslationRequest,
  type TranslationShape,
} from './prompt'

/**
 * Step 3 of the AI translation feature: take a batch of planned fields, get one
 * model answer for all of them, and turn it back into finished documents ready
 * for `upsertBlock`.
 *
 * The model itself is injected rather than imported, for two reasons. It keeps
 * this module pure and fully testable offline (every adversarial answer a model
 * could give is just another fake `Translator`, with no tokens spent and no
 * network), and it keeps the provider choice in the server action of step 4,
 * where the API key lives.
 *
 * One batch is one model call. Chunking across batches belongs to the caller —
 * see plan.ts's "take the next N from a freshly recomputed plan".
 */

/**
 * Given the built prompt, return the model's raw text answer.
 *
 * `shape` is the per-id fragment count, for a provider that can enforce it as
 * a structured-output schema. A translator is free to ignore it — the strict
 * per-field validation below runs either way, because a schema is an extra
 * lock on the answer's shape, not a reason to trust its contents unchecked.
 */
export type Translator = (prompt: {
  system: string
  user: string
  shape: TranslationShape
}) => Promise<string>

/** A finished field: exactly what step 4 hands to `upsertBlock`. */
export type TranslatedField = {
  blockKey: string
  section: string
  lang: Lang
  json: JSONContent
  sortOrder: number
}

export type FieldFailure = { blockKey: string; error: string }

export type BatchResult = {
  translated: TranslatedField[]
  failed: FieldFailure[]
  /** True when no model call was made (nothing in the batch needed one). */
  skippedModel: boolean
  /**
   * Set when the model call itself failed (threw, or answered with something
   * that isn't a JSON object) rather than one field's entry being wrong. The
   * caller's loop treats these differently: a bad entry is about *that field*,
   * while a failed call says nothing about the fields at all — only that the
   * service is struggling — so it's what a "stop asking for now" decision keys
   * on. Every model-bound field is also in `failed`, with this same message.
   */
  callError?: string
}

const HAS_LETTER = /\p{L}/u
const EDGES = /^(\s*)([\s\S]*?)(\s*)$/

/**
 * One text node of one field, as prepared for the request.
 *
 * `lead`/`trail` are the whitespace stripped off before sending and re-attached
 * after — **required for correctness, not tidiness.** A field with formatting is
 * split at the mark boundaries, and the space that separates two words often
 * lives at the end of its own fragment: "Mi historia" with "Mi" bolded is
 * `["Mi", " historia"]`. A model handed `" historia"` very often returns
 * `"story"` with the leading space quietly dropped, and the rebuilt field reads
 * "Mystory" — the marks are intact and the text is ruined. Trimming before the
 * call and restoring afterwards takes that decision away from the model
 * entirely: it only ever sees and returns the words.
 */
type PreparedSlot = { index: number; lead: string; trail: string }

type PreparedField = {
  field: PlannedField
  /** Assigned only once the field is known to need a model call. */
  id: string
  slots: PreparedSlot[]
  /** The trimmed cores, in slot order — what actually goes to the model. */
  cores: string[]
}

function splitEdges(text: string): { lead: string; core: string; trail: string } {
  const match = EDGES.exec(text)
  // The regex matches any string, so this is unreachable; the fallback only
  // exists to keep the types honest without a non-null assertion.
  if (!match) return { lead: '', core: text, trail: '' }
  return { lead: match[1], core: match[2], trail: match[3] }
}

/**
 * Which of a field's text nodes are worth sending. Same `\p{L}` test the
 * planner uses to skip a whole field, applied per node instead: a fragment
 * that's only whitespace, a number or a symbol reads the same in both languages
 * *and* is the single likeliest thing for a model to silently drop, which would
 * break the one-entry-per-fragment contract for the whole field. Leaving those
 * out of the request shrinks it and removes that failure mode; they're spliced
 * back in untouched afterwards.
 */
function prepare(field: PlannedField): PreparedField {
  const slots: PreparedSlot[] = []
  const cores: string[] = []
  field.texts.forEach((text, index) => {
    if (!HAS_LETTER.test(text)) return
    const { lead, core, trail } = splitEdges(text)
    slots.push({ index, lead, trail })
    cores.push(core)
  })
  return { field, id: '', slots, cores }
}

/**
 * Validate one field's entry from the model and rebuild its document.
 *
 * Strict on purpose: an entry with the wrong number of strings means we can no
 * longer tell which translated fragment belongs to which text node, and a
 * guess there puts the wrong words under the owner's bold/link/colour marks.
 * Failing the field leaves its target row untouched, so it simply shows up as
 * `missing` again in the next recomputed plan and gets another attempt.
 */
function rebuild(prepared: PreparedField, entry: unknown): JSONContent {
  const { field, slots, cores } = prepared

  if (!Array.isArray(entry)) {
    throw new Error('the model did not return a list of fragments for this field')
  }
  if (entry.length !== cores.length) {
    throw new Error(`expected ${cores.length} fragment(s), got ${entry.length}`)
  }
  const wrongType = entry.findIndex((value) => typeof value !== 'string')
  if (wrongType !== -1) {
    throw new Error(`fragment ${wrongType} is not a string`)
  }

  // Start from the source's own text and overwrite only the slots that were
  // sent, so a skipped fragment (whitespace, a number) is carried through
  // byte-for-byte rather than re-derived.
  const texts = [...field.texts]
  slots.forEach((slot, i) => {
    texts[slot.index] = `${slot.lead}${(entry[i] as string).trim()}${slot.trail}`
  })

  // Throws on its own if the count ever stopped matching; caught per field.
  return applyTextNodes(field.sourceJson, texts)
}

export async function translateBatch(
  fields: PlannedField[],
  from: Lang,
  to: Lang,
  translate: Translator
): Promise<BatchResult> {
  const translated: TranslatedField[] = []
  const failed: FieldFailure[] = []

  const prepared = fields.map(prepare)

  const finish = (item: PreparedField, json: JSONContent) => {
    translated.push({
      blockKey: item.field.blockKey,
      section: item.field.section,
      lang: to,
      json,
      sortOrder: item.field.sortOrder,
    })
  }

  // A field with no sendable fragment at all needs no model call — its text is
  // already language-neutral, so the "translation" is a faithful copy of the
  // source document. Writing it (rather than reporting a failure) is what keeps
  // the caller's re-plan loop terminating: a field that could never succeed
  // would otherwise come back as `missing` on every single pass, forever.
  const needsModel: PreparedField[] = []
  for (const item of prepared) {
    if (item.cores.length === 0) {
      try {
        finish(item, applyTextNodes(item.field.sourceJson, item.field.texts))
      } catch (err) {
        failed.push({ blockKey: item.field.blockKey, error: message(err) })
      }
    } else {
      needsModel.push(item)
    }
  }

  if (needsModel.length === 0) {
    return { translated, failed, skippedModel: true }
  }

  // Ids are opaque and assigned here rather than derived from the block_key:
  // shorter to send, and nothing about the app's own structure ends up in the
  // payload. Numbered over the fields actually being sent (so they're always
  // `f0`…`fN` with no gaps, whatever was resolved locally above), and the
  // mapping back is local to this call.
  needsModel.forEach((item, i) => {
    item.id = `f${i}`
  })

  const request: TranslationRequest = {
    from,
    to,
    fields: needsModel.map((item) => ({ id: item.id, texts: item.cores })),
  }

  // A thrown call or an unreadable answer fails every field that was waiting on
  // the model, and only those — anything already resolved above still counts.
  // Each failure carries the real reason so the progress UI can show it rather
  // than a generic "something went wrong".
  let response: Record<string, unknown>
  try {
    response = parseTranslationResponse(await translate(buildTranslationPrompt(request)))
  } catch (err) {
    const error = message(err)
    for (const item of needsModel) failed.push({ blockKey: item.field.blockKey, error })
    return { translated, failed, skippedModel: false, callError: error }
  }

  for (const item of needsModel) {
    try {
      if (!(item.id in response)) {
        throw new Error('the model left this field out of its answer')
      }
      finish(item, rebuild(item, response[item.id]))
    } catch (err) {
      failed.push({ blockKey: item.field.blockKey, error: message(err) })
    }
  }

  return { translated, failed, skippedModel: false }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
