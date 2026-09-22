import type { JSONContent } from '@tiptap/core'
import { isFontSizeCss } from './extensions/fontSize'
import { isAllowedColor, HIGHLIGHT_STYLE } from './extensions/colors'
import { isAllowedFontFamily } from './extensions/fontFamily'

/**
 * Turns a Tiptap document into HTML without touching Tiptap's own
 * generateHTML — that needs a DOM (jsdom) to run server-side, which this app
 * doesn't otherwise depend on. This walks the JSON directly instead.
 *
 * Deliberately whitelist-only: it can only ever emit the tags/attributes
 * handled explicitly below, regardless of what a node/mark type in the JSON
 * says. An unrecognized node just renders its children with no wrapping tag,
 * an unrecognized mark is skipped, and an unsafe link href is dropped
 * (rendered as plain text). A block's content_json reaches here from a
 * server action that already accepted it from the client, so this is the
 * layer that actually decides what can end up in HTML served to visitors.
 */
const MARK_TAGS: Record<string, string> = {
  bold: 'strong',
  italic: 'em',
  underline: 'u',
  strike: 's',
}

const TEXT_ALIGNMENTS = new Set(['left', 'center', 'right', 'justify'])

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Whitelist, not a blocklist: only http(s) and a well-formed mailto: pass.
 * Rejects javascript:, data:, protocol-relative //, and anything else that
 * doesn't match — a link mark with no safe href renders as plain text
 * rather than an <a> with a dropped/empty href.
 */
function isSafeHref(href: unknown): href is string {
  if (typeof href !== 'string') return false
  const trimmed = href.trim()
  return /^https?:\/\/\S+$/i.test(trimmed) || /^mailto:[^\s@]+@[^\s@]+\.\S+$/i.test(trimmed)
}

function renderMarks(text: string, marks: JSONContent['marks']): string {
  let html = escapeHtml(text)
  for (const mark of marks ?? []) {
    if (mark.type === 'textStyle') {
      const styles: string[] = []
      if (isFontSizeCss(mark.attrs?.fontSize)) styles.push(`font-size: ${mark.attrs?.fontSize}`)
      if (isAllowedColor(mark.attrs?.color)) styles.push(`color: ${mark.attrs?.color}`)
      if (isAllowedFontFamily(mark.attrs?.fontFamily)) styles.push(`font-family: ${mark.attrs?.fontFamily}`)
      if (styles.length) html = `<span style="${styles.join('; ')}">${html}</span>`
      continue
    }
    if (mark.type === 'highlight') {
      html = `<mark style="${HIGHLIGHT_STYLE}">${html}</mark>`
      continue
    }
    if (mark.type === 'link') {
      if (isSafeHref(mark.attrs?.href)) {
        html = `<a href="${escapeHtml(mark.attrs.href)}" target="_blank" rel="noopener noreferrer nofollow">${html}</a>`
      }
      continue
    }
    const tag = MARK_TAGS[mark.type]
    if (!tag) continue
    html = `<${tag}>${html}</${tag}>`
  }
  return html
}

function paragraphAlignStyle(node: JSONContent): string {
  const align = node.attrs?.textAlign
  return typeof align === 'string' && TEXT_ALIGNMENTS.has(align) ? ` style="text-align: ${align}"` : ''
}

function renderNode(node: JSONContent): string {
  if (node.type === 'text') return renderMarks(node.text ?? '', node.marks)

  const inner = (node.content ?? []).map(renderNode).join('')

  switch (node.type) {
    case 'paragraph':
      return `<p${paragraphAlignStyle(node)}>${inner}</p>`
    case 'doc':
    default:
      return inner
  }
}

export function renderBlockHtml(doc: JSONContent): string {
  if (!doc || typeof doc !== 'object') return ''
  return renderNode(doc)
}

/**
 * Same content, without the wrapping <p> — for embedding inline inside a
 * page element that already carries its own typography (a heading, an
 * existing <p>), where a nested block-level <p> would be invalid HTML and
 * could shift layout. Editable fields disable Enter, so in practice this is
 * always exactly one paragraph; multiple ever getting through (e.g. pasted
 * content) just lose the paragraph break rather than nesting invalidly.
 *
 * A paragraph's alignment still needs *some* block box to apply to, so
 * unlike renderBlockHtml's real <p>, this wraps in a <span
 * style="display:block">: a span carries no nesting restriction the way <p>
 * does (it's valid inside another <p> or a heading), while display:block
 * still gives text-align something to act on.
 */
export function renderInlineHtml(doc: JSONContent): string {
  if (!doc?.content?.length) return ''
  return doc.content
    .filter((node) => node.type === 'paragraph')
    .map((paragraph) => {
      const inner = (paragraph.content ?? [])
        .filter((node) => node.type === 'text')
        .map((node) => renderMarks(node.text ?? '', node.marks))
        .join('')
      const align = paragraph.attrs?.textAlign
      return typeof align === 'string' && TEXT_ALIGNMENTS.has(align)
        ? `<span style="display: block; text-align: ${align}">${inner}</span>`
        : inner
    })
    .join(' ')
}

const ALLOWED_NODES = new Set(['doc', 'paragraph', 'text'])
const ALLOWED_MARKS = new Set(Object.keys(MARK_TAGS))

/**
 * textStyle/highlight/link carry attributes rather than being a fixed tag
 * like the marks in MARK_TAGS, so each needs its own check. A mark that
 * ends up with nothing valid to render (an all-invalid textStyle, an unsafe
 * link href) is dropped entirely rather than kept with empty/unsafe attrs.
 */
function sanitizeMark(mark: unknown): { type: string; attrs?: Record<string, unknown> } | null {
  if (!mark || typeof mark !== 'object' || typeof (mark as { type?: unknown }).type !== 'string') return null
  const m = mark as { type: string; attrs?: Record<string, unknown> }

  if (m.type === 'textStyle') {
    const attrs: Record<string, unknown> = {}
    if (isFontSizeCss(m.attrs?.fontSize)) attrs.fontSize = m.attrs?.fontSize
    if (isAllowedColor(m.attrs?.color)) attrs.color = m.attrs?.color
    if (isAllowedFontFamily(m.attrs?.fontFamily)) attrs.fontFamily = m.attrs?.fontFamily
    return Object.keys(attrs).length ? { type: 'textStyle', attrs } : null
  }

  if (m.type === 'highlight') return { type: 'highlight' }

  if (m.type === 'link') {
    return isSafeHref(m.attrs?.href) ? { type: 'link', attrs: { href: m.attrs.href } } : null
  }

  return ALLOWED_MARKS.has(m.type) ? { type: m.type } : null
}

/**
 * Strips a client-submitted document down to only what this app's schema
 * actually supports, before it's ever stored — belt-and-suspenders on top of
 * renderBlockHtml's own whitelist, since a request can call the server
 * action directly without going through the editor UI at all. Also caps
 * total text length against an unbounded payload.
 */
export function sanitizeDoc(input: unknown, maxLength: number): JSONContent {
  let remaining = maxLength

  function walk(node: unknown): JSONContent | null {
    if (!node || typeof node !== 'object') return null
    const n = node as JSONContent
    if (typeof n.type !== 'string' || !ALLOWED_NODES.has(n.type)) return null

    if (n.type === 'text') {
      if (remaining <= 0) return null
      const text = typeof n.text === 'string' ? n.text.slice(0, remaining) : ''
      if (!text) return null
      remaining -= text.length
      const marks = Array.isArray(n.marks)
        ? n.marks.map(sanitizeMark).filter((m): m is { type: string; attrs?: Record<string, unknown> } => m !== null)
        : undefined
      return marks?.length ? { type: 'text', text, marks } : { type: 'text', text }
    }

    const content = Array.isArray(n.content)
      ? n.content.map(walk).filter((c): c is JSONContent => c !== null)
      : []
    const align = n.type === 'paragraph' && typeof n.attrs?.textAlign === 'string' && TEXT_ALIGNMENTS.has(n.attrs.textAlign)
      ? { attrs: { textAlign: n.attrs.textAlign } }
      : {}
    return { type: n.type, ...align, ...(content.length ? { content } : {}) }
  }

  const result = walk(input)
  return result && result.type === 'doc' ? result : EMPTY_DOC
}

// A block with no text yet — what a freshly-inserted row and a cleared
// field both look like.
export const EMPTY_DOC: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] }

export function isEmptyDoc(doc: JSONContent | null | undefined): boolean {
  if (!doc) return true
  return renderBlockHtml(doc).replace(/<p[^>]*><\/p>/g, '').trim() === ''
}

/**
 * The field's text with no markup at all — for the places a rich text value
 * has to become a plain string (an alt attribute, a heading in a modal, a
 * value stored in a text column). Walks the JSON rather than stripping tags
 * off the rendered HTML, so there are no escaped entities to decode back.
 */
export function plainTextFromDoc(doc: JSONContent | null | undefined): string {
  if (!doc) return ''
  let text = ''
  const walk = (node: JSONContent) => {
    if (typeof node.text === 'string') text += node.text
    node.content?.forEach(walk)
  }
  walk(doc)
  return text.replace(/\s+/g, ' ').trim()
}
