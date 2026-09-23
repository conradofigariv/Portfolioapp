import type { Lang } from '../portfolio'

/**
 * The wire protocol between this app and whatever language model does the
 * translating: what we send, and how we read what comes back.
 *
 * Kept separate from the orchestration in `translate-batch.ts` because these
 * are the two things a model can get wrong (the instructions, and the shape of
 * its answer), and they're the two things most likely to be tuned later
 * without touching how batches are assembled or applied.
 *
 * The payload is deliberately the least the model can be given: a flat object
 * of opaque ids pointing at arrays of plain strings. It never sees a
 * `block_key`, a section name, Tiptap JSON, a mark, or which part of the page
 * a field renders in — so there is nothing structural for it to damage, and
 * nothing in the payload that could read as an instruction about the app.
 */

export type TranslationRequest = {
  from: Lang
  to: Lang
  /** `id` is opaque and assigned per batch — see translate-batch.ts. */
  fields: { id: string; texts: string[] }[]
}

/**
 * How many strings each id must come back with — the same contract rule 1 of
 * the prompt states in words, in a form a provider's structured-output schema
 * can enforce outright.
 *
 * Provider-agnostic on purpose: this says *what* the shape is, and each
 * translator translates it into whatever its own API calls a response schema.
 * The validation in `translate-batch.ts` stays either way — a schema is an
 * extra lock, not a reason to trust the answer unchecked.
 */
export type TranslationShape = { id: string; count: number }[]

const LANGUAGE_NAMES: Record<Lang, string> = {
  es: 'Spanish',
  en: 'English',
}

/**
 * Rule 2 is the one that matters most and the one with a real, accepted cost.
 * A field's text arrives as several fragments because the owner applied
 * formatting inside it: "**Mi** historia" is `["Mi", " historia"]`, and those
 * fragments have to be translated *in place* so the bold mark still lands on
 * the same word after the round trip. When the target language would prefer a
 * different word order across that boundary, this protocol keeps the boundary
 * and takes the slightly stiffer wording — preserving formatting the owner set
 * by hand was the explicit priority, and a model free to reorder across
 * fragments has no way to tell us which mark should follow which word.
 */
export const SYSTEM_PROMPT = `You are a professional translator working on a person's own portfolio website: how they describe their career, their projects and themselves.

You will receive a JSON object. Each key is an opaque field id. Each value is an array of text fragments that together make up ONE field of that portfolio.

Rules:

1. Answer with a JSON object and nothing else — no prose, no explanation, no markdown, no code fences. It must have exactly the same keys, and for each key an array with exactly the same number of strings, in the same order.

2. A field's fragments are one continuous piece of text that was split at formatting boundaries (bold, italic, a link, a colour). Translate each fragment where it is. Never move words from one fragment into another, never merge two fragments, never split one into two, never leave one empty. If the target language would prefer a different word order across a boundary, keep the boundary and accept the slightly stiffer wording.

3. Translate only. Do not add, remove, summarise, expand, correct or reformat anything, and do not add punctuation the original does not have.

4. Leave proper nouns alone: people, companies, products, tools, technologies, universities, and job titles that are used as a brand or a formal title.

5. Leave numbers, dates, percentages, currencies, URLs, emails, file names and code identifiers exactly as they are.

6. This person is writing about their own work. Keep the first person, keep the tone (plain and professional, not marketing copy), and keep the same level of formality. Where the target language has a choice of register, use the neutral professional one.

7. If a fragment has nothing to translate — a number, a symbol, a name — return it unchanged. Return it anyway: every fragment must have an entry.`

export function buildTranslationPrompt(request: TranslationRequest): {
  system: string
  user: string
  shape: TranslationShape
} {
  const payload: Record<string, string[]> = {}
  for (const field of request.fields) payload[field.id] = field.texts

  return {
    system: SYSTEM_PROMPT,
    user: [
      `Translate from ${LANGUAGE_NAMES[request.from]} to ${LANGUAGE_NAMES[request.to]}.`,
      '',
      JSON.stringify(payload),
    ].join('\n'),
    shape: request.fields.map((field) => ({ id: field.id, count: field.texts.length })),
  }
}

/**
 * Read the model's answer into a plain object, tolerantly — but only about
 * *packaging*, never about content.
 *
 * Rule 1 asks for bare JSON, and models still wrap it in a ```json fence or a
 * "Here you go:" line often enough that refusing those would throw away
 * perfectly good translations. So the fences and any text around the object are
 * stripped here, and that is the whole extent of the leniency: the shape of
 * what's inside (one entry per id, the right number of strings, every one a
 * string) is checked per field in `translate-batch.ts`, and a field whose entry
 * is wrong is dropped rather than patched up.
 *
 * Throws on anything that isn't a JSON object, since that means the whole
 * batch's answer is unusable rather than one field's.
 */
export function parseTranslationResponse(raw: string): Record<string, unknown> {
  const text = raw.trim()
  // The outermost {...}: enough to survive a code fence, a leading sentence or
  // a trailing note, without trying to repair malformed JSON.
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) {
    throw new Error('The translation response contained no JSON object.')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    throw new Error('The translation response was not valid JSON.')
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The translation response was not a JSON object.')
  }
  return parsed as Record<string, unknown>
}
