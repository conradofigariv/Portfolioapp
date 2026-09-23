import type { JSONContent } from '@tiptap/core'

/**
 * The two halves of "translate a field without ever letting the model near
 * its structure": pull every text node out in document order, hand only
 * those strings to the translator, then put the results back into the same
 * slots of the original document.
 *
 * The obvious alternative — send the whole Tiptap JSON, ask for translated
 * JSON back — puts the document's shape in the model's hands, where one
 * dropped mark, renamed attr or reordered node silently corrupts a field
 * the owner spent time styling. Here the model cannot affect anything but
 * the characters inside a text node: marks and their attrs (href, color,
 * fontSize, fontFamily), node attrs (textAlign), node types and ordering
 * all come from the original document and are never re-derived.
 *
 * Both functions walk the tree the same way, so slot N in the array is
 * always the same text node in the document — that shared walk is the whole
 * contract, which is why they live together rather than in two modules.
 */
function walk(node: JSONContent, visit: (node: JSONContent) => void): void {
  visit(node)
  node.content?.forEach((child) => walk(child, visit))
}

/**
 * Every text node's string, in document order. Tolerates a null/empty doc
 * (returns []) — the planner counts these for fields that may have no
 * stored content at all.
 *
 * Adjacent nodes are *not* merged and whitespace-only nodes are *not*
 * dropped: a field like "Hola <b>mundo</b>" is three nodes ("Hola ", " ",
 * "mundo") depending on how it was typed, and that trailing space is what
 * keeps the words apart once the marks are re-applied. Anything that
 * translates these has to return the same number of entries, including the
 * ones it chooses to pass through unchanged.
 */
export function extractTextNodes(doc: JSONContent | null | undefined): string[] {
  const texts: string[] = []
  if (!doc) return texts
  walk(doc, (node) => {
    if (typeof node.text === 'string') texts.push(node.text)
  })
  return texts
}

/**
 * The inverse: a copy of `doc` with each text node's string replaced by the
 * matching entry of `texts`. Never mutates the input.
 *
 * Throws rather than returning a partial document — `texts` comes from a
 * language model, so a wrong length or a non-string entry means that
 * field's translation came back unusable, and the only safe outcomes are
 * "the whole field, correctly rebuilt" or "leave the field alone". The
 * caller is expected to catch this per field and carry on with the rest of
 * the batch.
 */
export function applyTextNodes(doc: JSONContent, texts: string[]): JSONContent {
  const expected = extractTextNodes(doc).length
  if (texts.length !== expected) {
    throw new Error(`Expected ${expected} text node(s), got ${texts.length}.`)
  }
  const wrongType = texts.findIndex((text) => typeof text !== 'string')
  if (wrongType !== -1) {
    throw new Error(`Text node ${wrongType} is not a string.`)
  }

  // JSON round-trip rather than structuredClone: ProseMirror builds each
  // node's `attrs` via Object.create(null), and an object with no prototype
  // is not something React's server-action serialization treats as plain
  // data (see useBlockPersistence.save's own comment — that exact gotcha
  // already broke saving once). Cloning through JSON normalizes those back
  // into ordinary objects on the way out, which is what the result has to
  // be to survive the trip to upsertBlock.
  const clone: JSONContent = JSON.parse(JSON.stringify(doc))
  let index = 0
  walk(clone, (node) => {
    if (typeof node.text === 'string') node.text = texts[index++]
  })
  return clone
}
