'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import Image from 'next/image'
import { useLang } from '../context/LanguageContext'
import { moveBeforeId } from '../lib/reorder'
import RichText from './editor/EditableText'
import { plainTextFromDoc } from '../lib/editor/render-html'
import { METRIC_GRID_COLS, metricHasValue } from '../lib/metric-visibility'
import EditableProjectGallery from './EditableProjectGallery'
import ProjectNarrative from './ProjectNarrative'
import ProjectTags from './ProjectTags'
import { AddButton, DragHandle, RemoveButton } from './EditControls'
import { deleteProjectData } from '../lib/portfolio-actions'

// Alternating sides; index into this by position, not by project identity.
const poses: Array<'left' | 'right'> = ['right', 'left']

function newProjectId() {
  return `project-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

export default function ProjectTimeline() {
  const { t, content, media, editing, updateBoth, blocks, lang } = useLang()
  const p = content.projects
  const sectionRef = useRef<HTMLDivElement>(null)
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set())
  const [openProject, setOpenProject] = useState<number | null>(null)
  const [managingProject, setManagingProject] = useState<number | null>(null)
  const [photoIdx, setPhotoIdx] = useState(0)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)

  useEffect(() => {
    const observers: IntersectionObserver[] = []

    p.items.forEach((_, idx) => {
      const el = document.getElementById(`project-item-${idx}`)
      if (!el) return

      const obs = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) {
            setVisibleItems((prev) => new Set([...prev, idx]))
          }
        },
        { threshold: 0.2 }
      )
      obs.observe(el)
      observers.push(obs)
    })

    return () => observers.forEach((o) => o.disconnect())
  }, [p.items])

  const gallery =
    openProject !== null ? media.projectImages[p.items[openProject].id] || [] : []

  const galleryLength = gallery.length
  const closeGallery = useCallback(() => setOpenProject(null), [])
  const prevPhoto = useCallback(
    () => setPhotoIdx((i) => (i - 1 + galleryLength) % galleryLength),
    [galleryLength]
  )
  const nextPhoto = useCallback(
    () => setPhotoIdx((i) => (i + 1) % galleryLength),
    [galleryLength]
  )

  useEffect(() => {
    if (openProject === null) return

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeGallery()
      if (e.key === 'ArrowLeft') prevPhoto()
      if (e.key === 'ArrowRight') nextPhoto()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openProject, closeGallery, prevPhoto, nextPhoto])

  function addProject() {
    const id = newProjectId()
    updateBoth((c) => ({
      ...c,
      projects: {
        ...c.projects,
        items: [
          ...c.projects.items,
          {
            id,
            year: new Date().getFullYear().toString(),
            tag: '',
            title: 'New project',
            narrative: ['What the problem was.'],
            metrics: [
              { label: 'Metric', value: '—' },
              { label: 'Metric', value: '—' },
              { label: 'Metric', value: '—' },
            ],
            tags: [],
          },
        ],
      },
    }))
  }

  function removeProject(id: string) {
    updateBoth((c) => ({
      ...c,
      projects: { ...c.projects, items: c.projects.items.filter((item) => item.id !== id) },
    }))
    // The array removal above only lands in the DB on the next Save (old
    // draft system) — but this project's migrated fields/photos live in
    // separate tables that system never touches, so they'd otherwise stay
    // orphaned forever. Fired immediately, independent of Save/dirty, same
    // as the block-list system's own add/remove.
    void deleteProjectData(id)
  }

  function dropProject(targetId: string) {
    setOverId(null)
    if (!dragId || dragId === targetId) {
      setDragId(null)
      return
    }
    const movedId = dragId
    updateBoth((c) => ({
      ...c,
      projects: { ...c.projects, items: moveBeforeId(c.projects.items, movedId, targetId) },
    }))
    setDragId(null)
  }

  return (
    <section id="projects" ref={sectionRef} className="section-padding bg-gradient-to-b from-dark-900 to-dark-800/30">
      <div className="container-main">
        <div className="mb-6 md:mb-8">
          <h2 className="heading-md mb-4">
            <RichText blockKey="projects.title" section="projects" placeholder="Section title" />
          </h2>
          {/* div, not p — see Hero.tsx's comment on the same pattern: a
              migrated RichText field's edit-mode Tiptap div can't legally
              sit inside a <p>. */}
          <div className="text-dark-400 text-lg max-w-2xl">
            <RichText blockKey="projects.subtitle" section="projects" placeholder="Subtitle" />
          </div>
        </div>

        <div className="space-y-16 md:space-y-32">
          {p.items.map((project, idx) => {
            const isRight = poses[idx % poses.length] === 'right'
            const isVisible = visibleItems.has(idx)
            const projectGallery = media.projectImages[project.id] ?? []
            const photo = projectGallery[0]
            const hasGallery = projectGallery.length > 0
            // For the card with no photo, which is drawn from the text instead:
            // the category (a company, for a job imported from a CV) large, and
            // its first letter as a faint watermark.
            const cardCategory = plainTextFromDoc(blocks[`projects.items.${project.id}.tag`]?.[lang]?.json)
            const cardMonogram = (
              cardCategory ||
              plainTextFromDoc(blocks[`projects.items.${project.id}.title`]?.[lang]?.json)
            )
              .trim()
              .charAt(0)
              .toUpperCase()
            // A visitor only sees metrics with a value (metric-visibility.ts);
            // with none, the whole row goes. The owner always sees all three.
            const shownMetrics = project.metrics
              .map((_, i) => i)
              .filter(
                (i) =>
                  editing ||
                  metricHasValue(plainTextFromDoc(blocks[`projects.items.${project.id}.metrics.${i}.value`]?.[lang]?.json))
              )

            return (
              <div
                key={project.id}
                id={`project-item-${idx}`}
                className={`relative rounded-2xl transition-all ${dragId === project.id ? 'opacity-40' : ''} ${
                  overId === project.id && dragId !== null && dragId !== project.id
                    ? 'outline outline-2 outline-offset-8 outline-dark-50/60'
                    : ''
                }`}
                onDragOver={(e) => {
                  if (!dragId) return
                  e.preventDefault()
                  setOverId(project.id)
                }}
                onDrop={() => dropProject(project.id)}
              >
                <div className={`grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-12 items-stretch ${isRight ? '' : 'md:[&>*:first-child]:order-2'}`}>

                  {/* Visual side */}
                  <div
                    role={hasGallery || editing ? 'button' : undefined}
                    tabIndex={hasGallery || editing ? 0 : undefined}
                    onClick={() => {
                      if (editing) {
                        setManagingProject(idx)
                        return
                      }
                      if (!hasGallery) return
                      setPhotoIdx(0)
                      setOpenProject(idx)
                    }}
                    onKeyDown={(e) => {
                      if (!hasGallery && !editing) return
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        if (editing) setManagingProject(idx)
                        else {
                          setPhotoIdx(0)
                          setOpenProject(idx)
                        }
                      }
                    }}
                    className={`group relative h-64 md:h-full md:min-h-[22rem] rounded-2xl overflow-hidden border border-dark-700 transition-all duration-700 ${
                      hasGallery || editing ? 'cursor-pointer' : ''
                    } ${
                      isVisible
                        ? 'opacity-100 translate-x-0 translate-y-0'
                        : isRight
                        ? 'md:opacity-0 md:-translate-x-12 opacity-0 -translate-y-8'
                        : 'md:opacity-0 md:translate-x-12 opacity-0 -translate-y-8'
                    }`}
                  >
                    {/* Project visual: the photo, or — with none — a card drawn
                        from the text. That used to be the owner's portrait,
                        faded back; fine for one project, but a CV import turns
                        every past job into a project with no photo, and the
                        same face behind each of them read as a mistake. The
                        category is repeated here (it's also on the content
                        side), so it's decorative: aria-hidden. */}
                    {photo ? (
                      <div className="absolute inset-0 bg-gradient-to-br from-dark-700 to-dark-800">
                        <Image
                          src={photo.src}
                          alt={photo.alt}
                          fill
                          quality={90}
                          unoptimized={photo.src.startsWith('blob:')}
                          style={{ objectPosition: photo.position || 'left center' }}
                          className={`object-cover opacity-90 transition-transform duration-500 ${
                            hasGallery ? 'group-hover:scale-105' : ''
                          }`}
                        />
                      </div>
                    ) : (
                      <div className="absolute inset-0 overflow-hidden bg-gradient-to-br from-dark-800 via-dark-800/70 to-dark-900">
                        <div className="absolute -top-24 -right-24 h-72 w-72 rounded-full bg-[#d8ff3e]/[0.05] blur-3xl" />
                        {cardMonogram && (
                          <span
                            aria-hidden
                            className="absolute -bottom-8 md:-bottom-12 right-3 md:right-6 select-none text-[10rem] md:text-[15rem] font-bold leading-none text-dark-50/[0.04]"
                          >
                            {cardMonogram}
                          </span>
                        )}
                        {cardCategory && (
                          <p
                            aria-hidden
                            className="absolute left-4 right-4 md:left-8 md:right-8 top-10 md:top-16 line-clamp-2 break-words text-2xl md:text-4xl font-bold leading-tight text-dark-100"
                          >
                            {cardCategory}
                          </p>
                        )}
                      </div>
                    )}

                    {/* Gradient for text legibility over photo */}
                    {photo && <div className="absolute inset-0 bg-gradient-to-t from-dark-900/90 via-dark-900/20 to-transparent" />}

                    {/* Gallery affordance badge */}
                    {(hasGallery || editing) && (
                      <div className="absolute top-4 md:top-8 right-4 md:right-8 flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-dark-900/70 backdrop-blur border border-dark-600 text-dark-100 text-xs font-medium opacity-0 group-hover:opacity-100 transition-opacity">
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M3 16l5-5 4 4 5-6 4 5M3 5h18v14H3V5z"
                          />
                        </svg>
                        {editing
                          ? `Edit photos${projectGallery.length ? ` · ${projectGallery.length}` : ''}`
                          : projectGallery.length > 1
                          ? `${t.projects.gallery.viewGallery} · ${projectGallery.length}`
                          : t.projects.gallery.viewPhoto}
                      </div>
                    )}

                    {/* Year + title overlay. Sits inside the whole card's own
                        onClick (opens the photo manager while editing) —
                        without stopping propagation here, clicking into
                        the title to edit it immediately re-triggers that
                        same click and the photo modal steals it back. Only
                        while editing: a visitor's click here should still
                        open the lightbox/gallery as before.

                        The wrapper itself is `inset-0` (it has to be, to
                        anchor the text to the card's bottom edge) but must
                        stay `pointer-events-none` — otherwise, since it's
                        painted on top of the whole photo, it swallows every
                        click anywhere on the card (not just on the text)
                        and the card's own onClick can never fire, making the
                        photo unclickable. Only the year/title spans
                        themselves opt back in with `pointer-events-auto`, so
                        a click still bubbles up from them to this div's
                        stopPropagation, but a click anywhere else on the
                        photo passes straight through to the card.

                        Same story for onKeyDown: the outer card treats a
                        keyboard Enter/Space as "activate" (opens the photo
                        modal) for its own role="button" accessibility, and
                        preventDefault()s Space specifically to stop the page
                        from scrolling — which also silently eats every space
                        bar keystroke typed into the title/year fields unless
                        stopped here first. */}
                    <div className="absolute inset-0 flex flex-col justify-end p-4 md:p-8 pointer-events-none">
                      <span
                        className="text-dark-400 text-xs font-mono tracking-widest uppercase mb-1 md:mb-2 pointer-events-auto"
                        onClick={(e) => {
                          if (editing) e.stopPropagation()
                        }}
                        onKeyDown={(e) => {
                          if (editing) e.stopPropagation()
                        }}
                      >
                        <RichText blockKey={`projects.items.${project.id}.year`} section="projects" placeholder="Year" />
                      </span>
                      <h3
                        className="text-xl md:text-3xl font-bold text-dark-50 leading-tight pointer-events-auto"
                        onClick={(e) => {
                          if (editing) e.stopPropagation()
                        }}
                        onKeyDown={(e) => {
                          if (editing) e.stopPropagation()
                        }}
                      >
                        <RichText blockKey={`projects.items.${project.id}.title`} section="projects" placeholder="Title" />
                      </h3>
                    </div>

                    {/* Decorative line */}
                    <div className="absolute top-4 md:top-8 left-4 md:left-8 w-6 md:w-8 h-0.5 bg-dark-50/40" />
                  </div>

                  {/* Content side */}
                  <div
                    className={`transition-all duration-700 delay-150 ${
                      isVisible
                        ? 'opacity-100 translate-x-0 translate-y-0'
                        : isRight
                        ? 'md:opacity-0 md:translate-x-12 opacity-0 translate-y-8'
                        : 'md:opacity-0 md:-translate-x-12 opacity-0 translate-y-8'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3 mb-2">
                      {/* flex-1 + min-w-0: without real width to grow into, this
                          span shrink-wraps to its own text (a flex-row item with
                          no grow always does) — the toolbar's alignment buttons
                          would then have no slack to visibly shift text into. */}
                      <span className="flex-1 min-w-0 text-sm md:text-base font-mono text-dark-50 uppercase tracking-widest">
                        <RichText blockKey={`projects.items.${project.id}.tag`} section="projects" placeholder="Category" />
                      </span>
                      {editing && (
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <DragHandle
                            onDragStart={() => setDragId(project.id)}
                            onDragEnd={() => {
                              setDragId(null)
                              setOverId(null)
                            }}
                          />
                          <RemoveButton onClick={() => removeProject(project.id)} label="Remove project" />
                        </div>
                      )}
                    </div>

                    {/* Narrative */}
                    <ProjectNarrative projectId={project.id} />

                    {/* Metrics — always exactly 3, never owner-added/removed,
                        so each is a fixed-index scalar block rather than a
                        useBlockList-managed list. */}
                    {shownMetrics.length > 0 && (
                    <div
                      className={`grid ${METRIC_GRID_COLS[shownMetrics.length] ?? 'grid-cols-3'} gap-2 md:gap-4 mb-5 md:mb-7 py-4 md:py-5 border-y border-dark-700`}
                    >
                      {shownMetrics.map((i) => (
                        <div key={i} className="text-center">
                          <p className="text-dark-400 text-xs uppercase tracking-wider mb-1 md:mb-2">
                            <RichText
                              blockKey={`projects.items.${project.id}.metrics.${i}.label`}
                              section="projects"
                              placeholder="Metric"
                            />
                          </p>
                          <p className="text-lg md:text-2xl font-bold text-dark-50">
                            <RichText
                              blockKey={`projects.items.${project.id}.metrics.${i}.value`}
                              section="projects"
                              placeholder="Value"
                            />
                          </p>
                        </div>
                      ))}
                    </div>
                    )}

                    {/* Tags */}
                    <ProjectTags projectId={project.id} />
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {editing && (
          // data-tour-target: the onboarding tour's "add your projects" step
          // points here — see app/lib/onboarding-tour.ts.
          <div data-tour-target="add-project" className="mt-8 max-w-md mx-auto">
            <AddButton label="Add project" onClick={addProject} />
          </div>
        )}

        {/* Bottom CTA */}
        <div className="mt-32 text-center max-w-2xl mx-auto">
          <h3 className="text-2xl font-bold mb-4">
            <RichText blockKey="projects.ctaTitle" section="projects" placeholder="CTA title" />
          </h3>
          <div className="text-dark-400 mb-8">
            <RichText blockKey="projects.ctaDescription" section="projects" placeholder="CTA description" />
          </div>
        </div>
      </div>

      {managingProject !== null &&
        createPortal(
          <EditableProjectGallery
            projectId={p.items[managingProject].id}
            title={p.items[managingProject].title}
            photos={media.projectImages[p.items[managingProject].id] ?? []}
            onClose={() => setManagingProject(null)}
          />,
          document.body
        )}

      {openProject !== null &&
        gallery.length > 0 &&
        createPortal(
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4"
            onClick={closeGallery}
          >
            <div
              className="bg-dark-800 border border-dark-700 rounded-xl w-full max-w-4xl flex flex-col overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between px-4 py-3 border-b border-dark-700">
                <span className="text-dark-50 font-semibold text-sm">
                  {p.items[openProject].title}
                  {gallery.length > 1 && (
                    <span className="text-dark-400 font-normal ml-2">
                      {photoIdx + 1} / {gallery.length}
                    </span>
                  )}
                </span>
                <button
                  onClick={closeGallery}
                  aria-label={t.projects.gallery.close}
                  className="text-dark-300 hover:text-dark-50 transition p-1.5"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <div className="relative h-[50vh] md:h-[65vh] bg-dark-900">
                <Image
                  key={gallery[photoIdx].src}
                  src={gallery[photoIdx].src}
                  alt={gallery[photoIdx].alt}
                  fill
                  quality={90}
                  className="object-contain"
                />

                {gallery.length > 1 && (
                  <>
                    <button
                      onClick={prevPhoto}
                      aria-label={t.projects.gallery.previous}
                      className="absolute left-2 md:left-4 top-1/2 -translate-y-1/2 flex items-center justify-center w-9 h-9 md:w-10 md:h-10 rounded-full bg-dark-900/70 border border-dark-600 text-dark-100 hover:bg-dark-900 transition"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                      </svg>
                    </button>
                    <button
                      onClick={nextPhoto}
                      aria-label={t.projects.gallery.next}
                      className="absolute right-2 md:right-4 top-1/2 -translate-y-1/2 flex items-center justify-center w-9 h-9 md:w-10 md:h-10 rounded-full bg-dark-900/70 border border-dark-600 text-dark-100 hover:bg-dark-900 transition"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </button>
                  </>
                )}
              </div>

              {gallery.length > 1 && (
                <div className="flex items-center gap-2 px-4 py-3 border-t border-dark-700 overflow-x-auto">
                  {gallery.map((g, i) => (
                    <button
                      key={g.src}
                      onClick={() => setPhotoIdx(i)}
                      className={`relative flex-shrink-0 w-16 h-12 rounded-md overflow-hidden border-2 transition ${
                        i === photoIdx ? 'border-dark-50' : 'border-transparent opacity-60 hover:opacity-100'
                      }`}
                    >
                      <Image src={g.src} alt={g.alt} fill className="object-cover" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>,
          document.body
        )}
    </section>
  )
}
