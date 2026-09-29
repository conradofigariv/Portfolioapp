'use client'

import { useEffect, useState } from 'react'
import { useLang } from '../context/LanguageContext'
import RichText from './editor/EditableText'
import { plainTextFromDoc } from '../lib/editor/render-html'
import { METRIC_GRID_COLS, metricHasValue } from '../lib/metric-visibility'
import EditablePortrait from './EditablePortrait'

export default function Hero() {
  const [isLoaded, setIsLoaded] = useState(false)
  const [videoIndex, setVideoIndex] = useState(0)
  const { content, media, editing, blocks, lang } = useLang()
  // A visitor only sees stats with a value — see metric-visibility.ts.
  const shownStats = content.stats
    .map((_, i) => i)
    .filter((i) => editing || metricHasValue(plainTextFromDoc(blocks[`stats.${i}.value`]?.[lang]?.json)))
  const videos = media.backgroundVideos

  useEffect(() => {
    setIsLoaded(true)
  }, [])

  return (
    <section
      className="relative min-h-[70vh] flex items-center py-10 md:py-12 lg:py-16 overflow-hidden"
      style={editing ? { paddingBottom: '6rem' } : undefined}
    >
      {/* Background video */}
      {videos.length > 0 && (
        <video
          key={videos[videoIndex % videos.length]}
          autoPlay
          muted
          loop
          playsInline
          className="absolute inset-0 w-full h-full object-cover"
        >
          <source src={videos[videoIndex % videos.length]} type="video/mp4" />
        </video>
      )}

      {/* Overlay for readability */}
      <div className="absolute inset-0 bg-gradient-to-b from-dark-900/80 via-dark-900/70 to-dark-900/90" />

      {videos.length > 1 && (
        <div className="absolute top-6 right-6 z-30">
          <button
            onClick={() => setVideoIndex((i) => (i + 1) % videos.length)}
            className="px-3 py-1.5 rounded-lg border border-dark-400/40 bg-dark-900/40 backdrop-blur text-dark-200 hover:text-dark-50 hover:border-dark-200 transition text-xs font-mono"
          >
            Video {(videoIndex % videos.length) + 1} / {videos.length}
          </button>
        </div>
      )}

      <div className="container-main w-full relative z-10">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 md:gap-16 items-stretch">
          {/* Left: Content. The portrait stretches to match this column's
              natural height (see the grid's items-stretch + EditablePortrait's
              h-full), so its bottom lines up with the stats no matter how
              long the name/tagline/description run. */}
          <div
            className={`transition-all duration-1000 ${
              isLoaded ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'
            }`}
          >
            {/* These wrap a migrated RichText field, so `div` rather than
                `p` — in edit mode Tiptap's EditorContent renders its own
                `<div>`, and a `<div>` inside a `<p>` is invalid HTML
                (browsers auto-close the `<p>` early, which React flags as
                a nesting error). Purely typographic Tailwind classes work
                identically on a div. */}
            <div className="text-dark-400 font-mono tracking-widest uppercase text-xs md:text-sm mb-2 md:mb-3">
              <RichText blockKey="hero.greeting" section="hero" placeholder="Greeting" />
            </div>
            {/* data-tour-target: the onboarding tour's "click and type" step
                points here — see app/lib/onboarding-tour.ts. */}
            <h1
              data-tour-target="hero-name"
              className="text-4xl md:text-6xl font-bold mb-4 md:mb-6 tracking-tight text-dark-50"
            >
              <RichText blockKey="hero.name" section="hero" placeholder="Your name" />
            </h1>
            <div className="text-xl md:text-3xl text-dark-200 mb-4 md:mb-6 leading-tight font-light">
              <RichText blockKey="hero.tagline" section="hero" placeholder="Headline" />
            </div>
            <div className="text-sm md:text-base text-dark-400 max-w-xl mb-3 md:mb-4 leading-relaxed">
              <RichText blockKey="hero.description" section="hero" placeholder="Description" />
            </div>

            {/* Stats */}
            {shownStats.length > 0 && (
              <div
                className={`pt-3 md:pt-4 border-t border-dark-700 grid ${METRIC_GRID_COLS[shownStats.length] ?? 'grid-cols-3'} gap-3 md:gap-6`}
              >
                {shownStats.map((i) => (
                  <div key={i} className="text-center">
                    <div className="text-xl md:text-2xl font-bold text-dark-50">
                      <RichText blockKey={`stats.${i}.value`} section="hero" placeholder="Value" />
                    </div>
                    <div className="text-dark-400 text-xs md:text-sm mt-1">
                      <RichText blockKey={`stats.${i}.label`} section="hero" placeholder="Label" />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Right: Real photo. Was `hidden` below `md` entirely — reported
              live as the portrait not showing on mobile at all. Now shown
              there too, `order-first` so it renders like a cover photo above
              the text column instead of after it (DOM order — and therefore
              default grid/flex order — has text first, photo second, which
              is already the right order for the two-column desktop layout,
              so only mobile needs an override; `md:order-none` drops back to
              that natural order from `md` up). */}
          {(media.portrait || editing) && (
            <div
              className={`order-first md:order-none flex justify-center mb-6 md:mb-0 transition-all duration-1000 delay-300 ${
                isLoaded ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'
              }`}
            >
              <EditablePortrait />
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
