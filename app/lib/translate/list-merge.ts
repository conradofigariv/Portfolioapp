import type { ListKind } from './plan'

/**
 * The review's per-item selection for one list: what can be picked, what's
 * picked by default, and what the final list is.
 *
 * Replaced a three-button choice (keep / replace / remove copies) after the
 * owner asked to pick item by item instead: "mostrás lo que hay más lo que se
 * agregaría y elegís clickeando." Agreed details:
 *
 * - **Short items (tags, skills, availability) are a checklist**; **long ones
 *   (project lines, certifications) are pairs** — the same content in different
 *   words, so they're lined up by position and the owner picks one version.
 * - **Rows with identical text are merged** into one, carrying every origin
 *   ("React · yours · translation"), so the result can never hold two of the
 *   same thing by accident.
 * - **Default = "yours + what's missing"**: everything the owner wrote, plus a
 *   translation of whatever they don't have yet.
 * - **The result can be reordered by dragging** (in the panel).
 *
 * Pure and UI-free, so every one of those rules is checked offline.
 *
 * The unit of choice is a **slot**: one thing that can appear at most once in
 * the result, with one or more alternative texts for it. A slot can't hold two
 * picks, which is what makes duplicates impossible by construction; and since
 * a previous translation and the new one of the same source item always live
 * in the same slot, a result can never reference the same item id twice.
 */

export type Origin = 'own' | 'previous' | 'new'

/** Which stored item a pick keeps (a target row) or writes (a new translation). */
export type ItemRef = { from: 'target' | 'source'; itemId: string }

export type Alt = {
  /** Unique within its slot. */
  key: string
  text: string
  /** Every origin that produced this exact text — merged rows carry several. */
  origins: Origin[]
  /**
   * What picking it writes. A target item is preferred over a new translation
   * when both say the same thing: keeping an existing row changes nothing.
   */
  ref: ItemRef
}

export type Slot = {
  id: string
  alts: Alt[]
  /** Status of the source item behind it, when there is one. */
  sourceStatus?: 'shared' | 'changed' | 'new'
  /** Where it sits on the page today (lowest sort order of its target items); Infinity if nowhere. */
  anchor: number
  /** Its source item's position, or null for a slot that's only the owner's own item. */
  sourceIndex: number | null
}

export type MergeMode = 'check' | 'pairs'

export type MergeList = {
  kind: ListKind
  source: { itemId: string; text: string; sortOrder: number; keys: string[]; status: 'shared' | 'changed' | 'new' }[]
  target: { itemId: string; text: string; sortOrder: number; shared: boolean }[]
}

/** Picks per slot (an alt key, or absent for "not in the result") and the result's order. */
export type Selection = { picks: Record<string, string>; order: string[] }

export type Preset = 'recommended' | 'mine' | 'translated'

export function modeFor(kind: ListKind): MergeMode {
  return kind === 'narrative' || kind === 'certs' ? 'pairs' : 'check'
}

/** Case, accents' composed form and spacing don't make two items different. */
export function normalize(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim()
}

const ORIGIN_RANK: Record<Origin, number> = { own: 0, previous: 1, new: 2 }

/** Merge alternatives with the same text; the merged one keeps the best ref. */
function mergeAlts(alts: { text: string; origin: Origin; ref: ItemRef }[]): Alt[] {
  const merged = new Map<string, Alt>()
  for (const alt of alts) {
    const norm = normalize(alt.text)
    if (!norm) continue
    const existing = merged.get(norm)
    if (!existing) {
      merged.set(norm, { key: `${alt.origin}:${alt.ref.itemId}`, text: alt.text, origins: [alt.origin], ref: alt.ref })
      continue
    }
    if (!existing.origins.includes(alt.origin)) existing.origins.push(alt.origin)
    const best = Math.min(...existing.origins.map((o) => ORIGIN_RANK[o]))
    if (ORIGIN_RANK[alt.origin] <= best) {
      existing.ref = alt.ref
      existing.text = alt.text
      existing.key = `${alt.origin}:${alt.ref.itemId}`
    }
  }
  return [...merged.values()].sort(
    (a, b) => Math.min(...a.origins.map((o) => ORIGIN_RANK[o])) - Math.min(...b.origins.map((o) => ORIGIN_RANK[o]))
  )
}

/**
 * Build the slots for one list.
 *
 * `translated` maps a source item id to its new translation's text (already
 * joined across fields for a certification). A source item whose translation
 * didn't come back simply has no "new" alternative.
 */
export function buildSlots(list: MergeList, translated: Record<string, string>): Slot[] {
  const mode = modeFor(list.kind)
  const own = list.target.filter((item) => !item.shared).sort((a, b) => a.sortOrder - b.sortOrder)
  const copies = new Map(list.target.filter((item) => item.shared).map((item) => [item.itemId, item]))
  const source = [...list.source].sort((a, b) => a.sortOrder - b.sortOrder)

  const slots: Slot[] = []
  source.forEach((item, i) => {
    const raw: { text: string; origin: Origin; ref: ItemRef }[] = []
    const pairedOwn = mode === 'pairs' ? own[i] : undefined
    if (pairedOwn) raw.push({ text: pairedOwn.text, origin: 'own', ref: { from: 'target', itemId: pairedOwn.itemId } })
    const copy = copies.get(item.itemId)
    if (copy) raw.push({ text: copy.text, origin: 'previous', ref: { from: 'target', itemId: copy.itemId } })
    const text = translated[item.itemId]
    if (text) raw.push({ text, origin: 'new', ref: { from: 'source', itemId: item.itemId } })
    const alts = mergeAlts(raw)
    if (alts.length === 0) return
    slots.push({
      id: `s:${item.itemId}`,
      alts,
      sourceStatus: item.status,
      anchor: Math.min(pairedOwn?.sortOrder ?? Infinity, copy?.sortOrder ?? Infinity),
      sourceIndex: i,
    })
  })

  // The owner's items that no pair took. In a checklist that's all of them:
  // each joins the slot that already says the same thing, or gets its own.
  const leftover = mode === 'pairs' ? own.slice(source.length) : own
  for (const item of leftover) {
    const norm = normalize(item.text)
    if (!norm) continue
    const alt: Alt = { key: `own:${item.itemId}`, text: item.text, origins: ['own'], ref: { from: 'target', itemId: item.itemId } }
    const match = mode === 'check' ? slots.find((slot) => slot.alts.some((a) => normalize(a.text) === norm)) : undefined
    if (match) {
      const same = match.alts.find((a) => normalize(a.text) === norm)!
      if (!same.origins.includes('own')) {
        // The owner's own row wins the merge: keeping it changes nothing.
        same.origins.unshift('own')
        same.ref = alt.ref
        same.key = alt.key
        same.text = item.text
        match.anchor = Math.min(match.anchor, item.sortOrder)
      }
      // A second own item with the same text is a duplicate: it has no slot of
      // its own, so it isn't in the result, so it's removed.
      continue
    }
    slots.push({ id: `o:${item.itemId}`, alts: [alt], anchor: item.sortOrder, sourceIndex: null })
  }
  return slots
}

/** Page order first; anything not on the page yet after it, in source order. */
function naturalRank(slot: Slot): [number, number] {
  return [slot.anchor, slot.sourceIndex ?? Number.MAX_SAFE_INTEGER]
}

function byNatural(a: Slot, b: Slot): number {
  const [a1, a2] = naturalRank(a)
  const [b1, b2] = naturalRank(b)
  return a1 - b1 || a2 - b2
}

/**
 * The default pick for a slot — "yours + what's missing": the owner's own
 * version when there is one; otherwise the previous translation if the source
 * hasn't changed since (it's what's on the page), the new one if it has; and
 * the new translation for anything not on the page at all.
 */
function recommendedAlt(slot: Slot): Alt | undefined {
  const own = slot.alts.find((a) => a.origins.includes('own'))
  if (own) return own
  const previous = slot.alts.find((a) => a.origins.includes('previous'))
  const fresh = slot.alts.find((a) => a.origins.includes('new'))
  if (previous && (slot.sourceStatus !== 'changed' || !fresh)) return previous
  return fresh ?? previous
}

export function hasOwn(slots: Slot[]): boolean {
  return slots.some((slot) => slot.alts.some((a) => a.origins.includes('own')))
}

export function presetSelection(slots: Slot[], preset: Preset): Selection {
  const picks: Record<string, string> = {}
  for (const slot of slots) {
    const alt =
      preset === 'recommended'
        ? recommendedAlt(slot)
        : preset === 'mine'
          ? slot.alts.find((a) => a.origins.includes('own'))
          : slot.alts.find((a) => a.origins.includes('new'))
    if (alt) picks[slot.id] = alt.key
  }
  const ordered =
    preset === 'translated'
      ? [...slots].sort((a, b) => (a.sourceIndex ?? Infinity) - (b.sourceIndex ?? Infinity))
      : [...slots].sort(byNatural)
  return { picks, order: ordered.filter((slot) => slot.id in picks).map((slot) => slot.id) }
}

/**
 * Click an alternative: picking it replaces whatever the slot had; clicking
 * the one already picked takes the slot out of the result. A slot entering the
 * result goes where it naturally belongs among the ones already there (not
 * blindly at the end), so ticking something back on puts it back in place.
 */
export function toggleAlt(slots: Slot[], selection: Selection, slotId: string, altKey: string): Selection {
  const picks = { ...selection.picks }
  let order = [...selection.order]
  if (picks[slotId] === altKey) {
    delete picks[slotId]
    order = order.filter((id) => id !== slotId)
    return { picks, order }
  }
  const wasIn = slotId in picks
  picks[slotId] = altKey
  if (!wasIn) {
    const slot = slots.find((s) => s.id === slotId)!
    const at = order.findIndex((id) => {
      const other = slots.find((s) => s.id === id)
      return other ? byNatural(slot, other) < 0 : false
    })
    order.splice(at === -1 ? order.length : at, 0, slotId)
  }
  return { picks, order }
}

/** Pick → the stored item it keeps or writes, in the result's order. */
export function finalRefs(slots: Slot[], selection: Selection): ItemRef[] {
  const byId = new Map(slots.map((slot) => [slot.id, slot]))
  return selection.order
    .map((id) => byId.get(id)?.alts.find((a) => a.key === selection.picks[id])?.ref)
    .filter((ref): ref is ItemRef => !!ref)
}

/** The result as rows for the preview, with where each one comes from. */
export function resultRows(slots: Slot[], selection: Selection): { slotId: string; alt: Alt }[] {
  const byId = new Map(slots.map((slot) => [slot.id, slot]))
  return selection.order
    .map((id) => {
      const alt = byId.get(id)?.alts.find((a) => a.key === selection.picks[id])
      return alt ? { slotId: id, alt } : null
    })
    .filter((row): row is { slotId: string; alt: Alt } => row !== null)
}

/** Would applying this leave the list exactly as it is on the page? */
export function isUnchanged(list: MergeList, refs: ItemRef[]): boolean {
  const current = [...list.target].sort((a, b) => a.sortOrder - b.sortOrder)
  return (
    refs.length === current.length &&
    refs.every((ref, i) => ref.from === 'target' && ref.itemId === current[i].itemId)
  )
}

/** For the preview's summary line: what gets added and what gets removed. */
export function diffCounts(list: MergeList, refs: ItemRef[]): { added: number; removed: number } {
  const keptTarget = new Set(refs.filter((r) => r.from === 'target').map((r) => r.itemId))
  const written = new Set(refs.filter((r) => r.from === 'source').map((r) => r.itemId))
  const added = refs.filter((r) => r.from === 'source' && !list.target.some((t) => t.itemId === r.itemId)).length
  const removed = list.target.filter((t) => !keptTarget.has(t.itemId) && !written.has(t.itemId)).length
  return { added, removed }
}
