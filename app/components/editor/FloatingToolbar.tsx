'use client'

import { useEffect, useReducer, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useFloating, offset, flip, shift, autoUpdate, type VirtualElement } from '@floating-ui/react'
import type { Editor } from '@tiptap/react'
import ToolbarButton from './toolbar/ToolbarButton'
import FontFamilyControl from './toolbar/FontFamilyControl'
import FontSizeControl from './toolbar/FontSizeControl'
import ColorSwatches from './toolbar/ColorSwatches'
import HighlightButton from './toolbar/HighlightButton'
import LinkPopover from './toolbar/LinkPopover'
import AlignmentGroup from './toolbar/AlignmentGroup'

// Clicking into a field is often just moving between several fields fast —
// this delay keeps the toolbar from flickering in and out on every click.
// A real text selection (rule 2) skips it entirely; that's a deliberate act.
const FOCUS_DELAY_MS = 120

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const modKey = isMac ? '⌘' : 'Ctrl'

/**
 * Group separator. Hidden below `sm` because the toolbar wraps there (see the
 * className on the toolbar itself) — a 1px rule is the one child that can land
 * alone at the end of a wrapped row, reading as a stray mark rather than a
 * divider between anything. The wrap itself already separates the groups.
 */
function Divider() {
  return <div className="hidden sm:block w-px h-5 bg-dark-600 mx-0.5" />
}

/**
 * Anchors to the caret (empty selection) or the selection's bounding rect,
 * via ProseMirror's own coordsAtPos rather than the DOM Selection API — that
 * keeps this correct even for selections made with the keyboard, which don't
 * always produce a live window.getSelection() range.
 */
function selectionRect(editor: Editor): DOMRect {
  const { from, to, empty } = editor.state.selection
  if (empty) {
    const c = editor.view.coordsAtPos(from)
    return new DOMRect(c.left, c.top, 0, c.bottom - c.top)
  }
  const start = editor.view.coordsAtPos(from)
  const end = editor.view.coordsAtPos(to)
  const left = Math.min(start.left, end.left)
  const top = Math.min(start.top, end.top)
  return new DOMRect(left, top, Math.max(start.right, end.right) - left, Math.max(start.bottom, end.bottom) - top)
}

// True once the rect's own box no longer overlaps the viewport at all — the
// signal used to actually hide the toolbar on scroll, replacing a raw
// window.scrollX/Y distance check (see the scroll handler below for why).
function isOffscreen(rect: DOMRect): boolean {
  return rect.bottom < 0 || rect.top > window.innerHeight
}

export default function FloatingToolbar({ editor }: { editor: Editor | null }) {
  const [visible, setVisible] = useState(false)
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reduceMotion = useReducedMotion()

  // The link popover's input needs real DOM focus to type into, which fires
  // the editor's blur event — a ref (read inside the stable onBlur closure
  // below, so it doesn't need to be a dependency) is what stops that from
  // hiding the whole toolbar out from under it.
  const [linkOpen, setLinkOpen] = useState(false)
  const linkOpenRef = useRef(false)
  useEffect(() => {
    linkOpenRef.current = linkOpen
  }, [linkOpen])

  // editor.isActive()/getAttributes() below read live editor state at
  // render time — React has no way to know that state changed on its own,
  // so without this a toolbar already open (visible didn't flip) would keep
  // showing stale button/size states after the selection moves to a
  // differently-formatted run, or after a command runs.
  const [, forceUpdate] = useReducer((n: number) => n + 1, 0)

  const { refs, floatingStyles, placement } = useFloating({
    placement: 'top',
    middleware: [offset(8), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
    // floating-ui positions via `transform: translate(...)` by default —
    // Framer Motion also owns `transform` (for the enter/exit scale/y
    // animation) and overwrites it, which left the toolbar pinned at its
    // unpositioned top-left corner. `top`/`left` instead keeps the two out
    // of each other's way.
    transform: false,
  })

  useEffect(() => {
    if (!editor) return
    const activeEditor = editor

    // Reads the caret's *current* screen position fresh via coordsAtPos —
    // called again on every reposition (focus, selection change, and scroll
    // below), never cached. A virtual reference whose getBoundingClientRect
    // returned a value captured once at focus time used to go stale the
    // instant the page scrolled afterward: floating-ui's autoUpdate does
    // re-invoke that function on scroll, but a closure returning the same
    // frozen DOMRect every time just reproduces the same (now wrong)
    // position — coordsAtPos is viewport-relative, exactly like
    // getBoundingClientRect, so it only stays correct if it's actually
    // re-read after the scroll, not replayed from before it.
    function setReferenceFromSelection() {
      const rect = selectionRect(activeEditor)
      const virtual: VirtualElement = {
        getBoundingClientRect: () => rect,
        contextElement: activeEditor.view.dom,
      }
      refs.setReference(virtual)
      return rect
    }

    function place() {
      setReferenceFromSelection()
      setVisible(true)
    }

    function updateAnchor(delay: number) {
      if (showTimer.current) clearTimeout(showTimer.current)
      if (delay <= 0) {
        place()
      } else {
        showTimer.current = setTimeout(place, delay)
      }
    }

    function onFocus() {
      updateAnchor(activeEditor.state.selection.empty ? FOCUS_DELAY_MS : 0)
    }
    function onSelectionUpdate() {
      if (!activeEditor.isFocused) return
      updateAnchor(0)
    }
    function onBlur() {
      if (linkOpenRef.current) return
      if (showTimer.current) clearTimeout(showTimer.current)
      setVisible(false)
    }

    editor.on('focus', onFocus)
    editor.on('selectionUpdate', onSelectionUpdate)
    editor.on('blur', onBlur)
    // Every selection move and every formatting command fires a
    // transaction — forcing a render here is what keeps isActive()/
    // getAttributes() reads below from going stale between those.
    editor.on('transaction', forceUpdate)
    return () => {
      editor.off('focus', onFocus)
      editor.off('selectionUpdate', onSelectionUpdate)
      editor.off('blur', onBlur)
      editor.off('transaction', forceUpdate)
      if (showTimer.current) clearTimeout(showTimer.current)
    }
  }, [editor, refs, forceUpdate])

  useEffect(() => {
    if (!visible) return

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (linkOpenRef.current) {
          setLinkOpen(false)
          editor?.commands.focus()
          return
        }
        setVisible(false)
        editor?.commands.blur()
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setLinkOpen(true)
      }
    }
    // Re-reads the caret's position on every scroll rather than hiding on a
    // raw window.scrollX/Y distance — see setReferenceFromSelection's own
    // comment above for why a distance check on window scroll used to leave
    // the toolbar visibly wrong for a stretch before it caught up. This
    // matters most on mobile: focusing a field triggers the browser's own
    // scroll-the-input-into-view-above-the-keyboard animation, which fires a
    // burst of scroll events the toolbar now has to track live rather than
    // race. Only actually hides once the caret itself has scrolled off the
    // visible viewport — not merely "the page moved a few pixels."
    function onScroll() {
      if (!editor) return
      const rect = selectionRect(editor)
      if (isOffscreen(rect)) {
        setVisible(false)
        return
      }
      const virtual: VirtualElement = {
        getBoundingClientRect: () => rect,
        contextElement: editor.view.dom,
      }
      refs.setReference(virtual)
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [visible, editor, refs])

  if (!editor) return null

  // The frame should grow away from the text it's anchored to, not from its
  // own center — so the transform origin follows whichever side floating-ui
  // actually resolved (it flips to "bottom" near the top of the viewport).
  const origin = placement.startsWith('top') ? 'bottom' : 'top'

  const variants = reduceMotion
    ? {
        hidden: { opacity: 0 },
        visible: { opacity: 1, transition: { duration: 0.12, ease: 'easeOut' as const } },
        exit: { opacity: 0, transition: { duration: 0.12, ease: 'easeOut' as const } },
      }
    : {
        hidden: { opacity: 0, scale: 0.94, y: 6 },
        visible: {
          opacity: 1,
          scale: 1,
          y: 0,
          transition: { type: 'spring' as const, stiffness: 400, damping: 30, mass: 0.6 },
        },
        exit: { opacity: 0, scale: 0.96, transition: { duration: 0.12, ease: 'easeOut' as const } },
      }

  return createPortal(
    <AnimatePresence>
      {visible && (
        <motion.div
          // refs.setFloating is @floating-ui/react's memoized callback ref
          // setter (its documented usage), not a `.current` read — the
          // react-hooks/refs rule can't tell those apart by name alone.
          // eslint-disable-next-line react-hooks/refs
          ref={refs.setFloating}
          style={{ ...floatingStyles, transformOrigin: origin, zIndex: 120 }}
          variants={variants}
          initial="hidden"
          animate="visible"
          exit="exit"
          role="toolbar"
          aria-label="Text formatting"
          // `max-w` + `flex-wrap` is the actual fix for the toolbar running off
          // the side of a phone: at ~548px of controls it is simply wider than
          // any phone, and `shift()` cannot pull something wider than the
          // viewport back on screen — it also forced horizontal scroll on the
          // whole page. Capped to the viewport minus the 16px of padding the
          // offset/shift middleware already reserves, and allowed to become a
          // second row rather than being clipped. Desktop is untouched: there
          // the controls fit on one line and nothing wraps.
          className="flex flex-wrap items-center justify-center gap-1 rounded-lg border border-dark-600 bg-dark-800/95 backdrop-blur px-1.5 py-1 shadow-xl max-w-[calc(100vw-16px)]"
        >
          {/* Every direct child is a whole group, so a wrap can only ever
              happen *between* groups — never splitting the four alignment
              buttons or the colour/highlight/link trio across two rows. */}
          <div className="flex items-center gap-1">
            <ToolbarButton
              label="Bold"
              shortcut={`${modKey}B`}
              active={editor.isActive('bold')}
              onToggle={() => editor.chain().focus().toggleBold().run()}
            >
              <span className="font-bold">B</span>
            </ToolbarButton>
            <ToolbarButton
              label="Italic"
              shortcut={`${modKey}I`}
              active={editor.isActive('italic')}
              onToggle={() => editor.chain().focus().toggleItalic().run()}
            >
              <span className="italic">I</span>
            </ToolbarButton>
            <ToolbarButton
              label="Underline"
              shortcut={`${modKey}U`}
              active={editor.isActive('underline')}
              onToggle={() => editor.chain().focus().toggleUnderline().run()}
            >
              <span className="underline">U</span>
            </ToolbarButton>
            <ToolbarButton
              label="Strikethrough"
              shortcut={`Shift+${modKey}X`}
              active={editor.isActive('strike')}
              onToggle={() => editor.chain().focus().toggleStrike().run()}
            >
              <span className="line-through">S</span>
            </ToolbarButton>
          </div>
          <Divider />
          <FontFamilyControl editor={editor} />
          <Divider />
          <FontSizeControl editor={editor} />
          <Divider />
          <div className="flex items-center gap-1">
            <ColorSwatches editor={editor} />
            <HighlightButton editor={editor} />
            <LinkPopover editor={editor} open={linkOpen} onOpenChange={setLinkOpen} />
          </div>
          <Divider />
          <AlignmentGroup editor={editor} />
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}
