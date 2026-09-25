'use client'

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useLang } from '../context/LanguageContext'
import BackgroundPicker from './BackgroundPicker'
import AppLanguagePicker from './AppLanguagePicker'
import { FlagES, FlagUS } from './FlagIcon'
import DownloadPdfButton from './DownloadPdfButton'

export default function Navbar() {
  const [isOpen, setIsOpen] = useState(false)
  const [isCVOpen, setIsCVOpen] = useState(false)
  const { t, lang, toggleLang, content, media, editing } = useLang()

  const initials = content.hero.name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase()

  const navLinks = [
    { label: t.nav.about, href: '#about' },
    { label: t.nav.projects, href: '#projects' },
    { label: t.nav.skills, href: '#skills' },
    { label: t.nav.contact, href: '#contact' },
  ]

  return (
    <nav className="sticky top-0 z-50 bg-dark-900/95 backdrop-blur border-b border-dark-700">
      <div className="container-main flex items-center justify-between h-16">
        <AppLanguagePicker initials={initials} />

        {/* Desktop Navigation */}
        <div className="hidden md:flex gap-8">
          {navLinks.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="text-dark-300 hover:text-dark-50 transition text-sm"
            >
              {link.label}
            </a>
          ))}
        </div>

        {/* Right side: Lang toggle + CV */}
        <div className="hidden md:flex items-center gap-3">
          {/* data-tour-target: the onboarding tour's language step points at
              this exact attribute — see app/lib/onboarding-tour.ts. Nothing
              else about this button needs to know the tour exists. */}
          <button
            data-tour-target="language-toggle"
            onClick={toggleLang}
            className="flex items-center gap-1 p-1 rounded-lg border border-dark-400/40 text-xs font-mono"
            aria-label="Toggle language"
            aria-pressed={lang === 'es'}
          >
            {/* A solid pill behind whichever language is active, not just a
                bolder text color — reported as "no se ve claramente cual
                esta seleccionado": bold-on-dark-50 next to plain-on-dark-300
                was too subtle a contrast to register as "this one, not that
                one" at this size. */}
            <span
              className={`flex items-center gap-1 px-2 py-1 rounded-md transition ${
                lang === 'en' ? 'bg-dark-50 text-dark-900 font-bold' : 'text-dark-400'
              }`}
            >
              <FlagUS /> EN
            </span>
            <span
              className={`flex items-center gap-1 px-2 py-1 rounded-md transition ${
                lang === 'es' ? 'bg-dark-50 text-dark-900 font-bold' : 'text-dark-400'
              }`}
            >
              <FlagES /> ES
            </span>
          </button>

          <BackgroundPicker />

          {editing && (
            <form action="/auth/signout" method="post">
              <button type="submit" className="text-dark-300 hover:text-dark-50 transition text-sm">
                Cerrar sesión
              </button>
            </form>
          )}

          <DownloadPdfButton variant="nav" />

          {media.cv && (
            <button
              onClick={() => setIsCVOpen(true)}
              className="button-secondary text-sm py-2"
            >
              {t.nav.viewCV}
            </button>
          )}
        </div>

        {/* Mobile: lang toggle + hamburger */}
        <div className="md:hidden flex items-center gap-3">
          <button
            data-tour-target="language-toggle"
            onClick={toggleLang}
            className="flex items-center gap-1 p-1 rounded-lg border border-dark-400/40 text-xs font-mono"
            aria-label="Toggle language"
            aria-pressed={lang === 'es'}
          >
            {/* Used to show only the language you'd switch *to*, with no
                indication of the current one at all — on mobile there was
                nothing to even look "unclear," the current state simply
                wasn't shown. Same solid-pill treatment as the desktop
                version now, for the same reason. */}
            <span
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md transition ${
                lang === 'en' ? 'bg-dark-50 text-dark-900 font-bold' : 'text-dark-400'
              }`}
            >
              <FlagUS /> EN
            </span>
            <span
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md transition ${
                lang === 'es' ? 'bg-dark-50 text-dark-900 font-bold' : 'text-dark-400'
              }`}
            >
              <FlagES /> ES
            </span>
          </button>
          <BackgroundPicker />
          {editing && (
            <form action="/auth/signout" method="post">
              <button type="submit" className="text-dark-300 hover:text-dark-50 transition text-sm">
                Cerrar sesión
              </button>
            </form>
          )}
          <button
            className="text-dark-50"
            onClick={() => setIsOpen(!isOpen)}
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d={isOpen ? 'M6 18L18 6M6 6l12 12' : 'M4 6h16M4 12h16M4 18h16'}
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Mobile Navigation */}
      {isOpen && (
        <div className="md:hidden bg-dark-800 border-t border-dark-700">
          <div className="container-main py-4 flex flex-col gap-4">
            {navLinks.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="text-dark-300 hover:text-dark-50 transition"
                onClick={() => setIsOpen(false)}
              >
                {link.label}
              </a>
            ))}
            <DownloadPdfButton variant="menu" />
            {media.cv && (
              <button
                onClick={() => {
                  setIsOpen(false)
                  setIsCVOpen(true)
                }}
                className="button-secondary inline-block text-center text-sm"
              >
                {t.nav.viewCV}
              </button>
            )}
          </div>
        </div>
      )}

      {isCVOpen &&
        media.cv &&
        createPortal(
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4"
            onClick={() => setIsCVOpen(false)}
          >
            <div
              className="bg-dark-800 border border-dark-700 rounded-xl w-full max-w-5xl h-[92vh] flex flex-col overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between px-4 py-3 border-b border-dark-700">
                <span className="text-dark-50 font-semibold text-sm">CV</span>
                <div className="flex items-center gap-2">
                  <a
                    href={media.cv}
                    download
                    className="button-secondary text-sm py-1.5"
                  >
                    {t.nav.downloadCVAction}
                  </a>
                  <button
                    onClick={() => setIsCVOpen(false)}
                    aria-label={t.nav.closeCV}
                    className="text-dark-300 hover:text-dark-50 transition p-1.5"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                  </button>
                </div>
              </div>
              <iframe
                src={`${media.cv}#view=FitH`}
                title="CV"
                className="flex-1 w-full bg-white"
              />
            </div>
          </div>,
          document.body
        )}
    </nav>
  )
}
