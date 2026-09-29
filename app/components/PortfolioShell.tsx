import { LanguageProvider } from '../context/LanguageContext'
import type { Portfolio } from '../lib/portfolio'
import Navbar from './Navbar'
import Hero from './Hero'
import Journey from './Journey'
import ProjectTimeline from './ProjectTimeline'
import Skills from './Skills'
import Contact from './Contact'
import Footer from './Footer'
import HideableSection from './HideableSection'
import EditBar from './EditBar'
import OnboardingTour from './OnboardingTour'

// A whole portfolio, rendered from one person's data. The same components serve
// the public page and the editor — editing happens in place, so there is no
// second copy of the layout that could drift from this one.
export default function PortfolioShell({
  portfolio,
  editing = false,
  previewing = false,
  showTour = false,
  initialTourStep = 0,
  askUsername = false,
}: {
  portfolio: Portfolio
  editing?: boolean
  previewing?: boolean
  // Onboarding tour — see OnboardingTour.tsx and LanguageContext's `tour`.
  // Decided server-side (owner + not previewing + not dismissed yet).
  showTour?: boolean
  initialTourStep?: number
  /** The owner hasn't chosen their address yet — EditBar opens the picker. */
  askUsername?: boolean
}) {
  return (
    <LanguageProvider
      portfolio={portfolio}
      editing={editing}
      showTour={showTour}
      initialTourStep={initialTourStep}
    >
      {previewing && (
        <div className="sticky top-0 z-[95] flex items-center justify-center gap-3 bg-dark-50 text-dark-900 text-xs font-medium py-2 px-4 text-center">
          <span>Vista previa — así se ve tu portfolio para cualquiera.</span>
          <a href={`/${portfolio.username}`} className="underline hover:no-underline">
            Volver a editar
          </a>
        </div>
      )}
      <Navbar />
      <main>
        <Hero />
        <HideableSection id="journey">
          <Journey />
        </HideableSection>
        <HideableSection id="projects">
          <ProjectTimeline />
        </HideableSection>
        <HideableSection id="skills">
          <Skills />
        </HideableSection>
        <HideableSection id="contact">
          <Contact />
        </HideableSection>
      </main>
      <Footer />
      <EditBar username={portfolio.username} askUsername={askUsername} />
      {/* Reads its own target/state from context, so it can render nothing
          (owner not showing it) or point at anything on this page (the
          language toggle in Navbar above, the name in Hero, ...) without
          needing to be threaded through each of those components. */}
      <OnboardingTour />
    </LanguageProvider>
  )
}
