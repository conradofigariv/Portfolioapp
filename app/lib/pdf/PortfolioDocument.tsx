import { Document, Font, Image, Link, Page, StyleSheet, Text, View } from '@react-pdf/renderer'
import type { Style } from '@react-pdf/types'
import { isEmptyRich, type PdfImage, type PdfModel, type Rich } from './model'

/**
 * The portfolio as an A4 portrait document. Pure layout over a `PdfModel`
 * (model.ts) — no block keys, no languages, no data fetching.
 *
 * Designed for paper, not copied from the page (the owner's explicit pick):
 * white background, near-black text, the brand lime kept only as a thin
 * decorative bar — lime *text* is unreadable on white, so accent text uses a
 * dark olive from the same hue instead. Same content and hierarchy as the web
 * page, in the same order.
 *
 * Only ever loaded on demand: this module (and react-pdf with it, ~1MB) is
 * imported by export.ts inside the download click handler, never at page load,
 * so a visitor who doesn't download pays nothing for it.
 */

export type PdfLabels = {
  certifications: string
  email: string
  page: string
  livePortfolio: string
}

const INK = '#111114'
const BODY = '#34343a'
const MUTED = '#6b6b73'
const FAINT = '#9a9aa3'
const RULE = '#e6e6ea'
const TINT = '#f5f5f7'
const LIME = '#d8ff3e'
const ACCENT_TEXT = '#4f5d00'

let fontsRegistered = false

/**
 * Inter, served from /public/fonts/inter (converted to TTF from the `inter-ui`
 * package's full-glyph web files; OFL, licence alongside). A registered font
 * rather than react-pdf's built-in Helvetica because Helvetica only covers the
 * WinAnsi code page: accents and ñ are fine, but an arrow, a "≈", a Greek
 * letter or anything else an owner might type would print as a wrong glyph.
 *
 * `base` is a URL prefix in the browser and a directory in the offline
 * verification harness — the only difference between the two.
 */
export function registerPdfFonts(base: string) {
  if (fontsRegistered) return
  fontsRegistered = true
  Font.register({
    family: 'Inter',
    fonts: [
      { src: `${base}/Inter-Regular.ttf` },
      { src: `${base}/Inter-Italic.ttf`, fontStyle: 'italic' },
      { src: `${base}/Inter-SemiBold.ttf`, fontWeight: 600 },
      { src: `${base}/Inter-Bold.ttf`, fontWeight: 700 },
      {
        src: `${base}/Inter-BoldItalic.ttf`,
        fontWeight: 700,
        fontStyle: 'italic',
      },
    ],
  })
  // react-pdf hyphenates with English rules by default, splitting Spanish
  // words in the wrong places ("ne-gocios"). Whole words only.
  Font.registerHyphenationCallback((word) => [word])
}

const s = StyleSheet.create({
  // No lineHeight here: set on the Page, react-pdf silently drops every
  // `fixed` element — the running footer vanished from all pages, found by
  // bisecting page styles until it came back. Nor on a wrapping View: it gets
  // resolved against that View's own font size and inherited as a fixed
  // number, which nearly double-spaced every paragraph. It's set per text
  // instead — `R` applies BODY_LINE to every field, and each style that needs
  // tighter leading overrides it.
  page: {
    fontFamily: 'Inter',
    fontSize: 9.5,
    color: BODY,
    paddingTop: 44,
    paddingBottom: 60,
    paddingHorizontal: 48,
  },
  footer: {
    position: 'absolute',
    bottom: 26,
    left: 48,
    right: 48,
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: 0.5,
    borderTopColor: RULE,
    paddingTop: 7,
    fontSize: 7.5,
    color: FAINT,
  },
  footerLink: { color: FAINT, textDecoration: 'none' },

  hero: { flexDirection: 'row', gap: 20, alignItems: 'flex-start' },
  portrait: { width: 96, height: 96, borderRadius: 10, objectFit: 'cover' },
  heroText: { flex: 1 },
  greeting: { fontSize: 9, color: MUTED, marginBottom: 2 },
  name: { fontSize: 24, fontWeight: 700, color: INK, lineHeight: 1.15 },
  tagline: {
    fontSize: 12,
    fontWeight: 600,
    color: INK,
    marginTop: 6,
    lineHeight: 1.35,
  },
  description: { fontSize: 9.5, color: MUTED, marginTop: 5 },
  contactLine: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 8,
    fontSize: 8.5,
    color: MUTED,
  },
  contactItem: { marginRight: 12, color: MUTED, textDecoration: 'none' },

  stats: { flexDirection: 'row', gap: 10, marginTop: 20 },
  stat: {
    flex: 1,
    backgroundColor: TINT,
    borderRadius: 6,
    paddingVertical: 9,
    paddingHorizontal: 11,
  },
  statValue: { fontSize: 15, fontWeight: 700, color: INK, lineHeight: 1.2 },
  statLabel: { fontSize: 8, color: MUTED, marginTop: 2 },

  section: { marginTop: 26 },
  sectionHead: { marginBottom: 12 },
  sectionBar: {
    width: 22,
    height: 3,
    backgroundColor: LIME,
    borderRadius: 2,
    marginBottom: 7,
  },
  sectionTitle: { fontSize: 15, fontWeight: 700, color: INK, lineHeight: 1.2 },
  sectionSubtitle: { fontSize: 9.5, color: MUTED, marginTop: 4 },

  eyebrow: {
    fontSize: 7.5,
    fontWeight: 600,
    color: ACCENT_TEXT,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 2,
  },

  chapter: { flexDirection: 'row', gap: 16, marginBottom: 14 },
  chapterText: { flex: 1 },
  chapterHeading: {
    fontSize: 11.5,
    fontWeight: 600,
    color: INK,
    lineHeight: 1.3,
    marginBottom: 3,
  },
  chapterPhoto: { width: 132, height: 88, borderRadius: 6, objectFit: 'cover' },

  project: {
    marginBottom: 18,
    paddingBottom: 16,
    borderBottomWidth: 0.5,
    borderBottomColor: RULE,
  },
  projectLast: { borderBottomWidth: 0, paddingBottom: 0 },
  projectTop: { flexDirection: 'row', gap: 16 },
  projectCover: {
    width: 168,
    height: 112,
    borderRadius: 6,
    objectFit: 'cover',
  },
  projectMain: { flex: 1 },
  projectTitle: {
    fontSize: 13,
    fontWeight: 700,
    color: INK,
    lineHeight: 1.25,
    marginBottom: 6,
  },
  bullet: { flexDirection: 'row', marginBottom: 3 },
  bulletDot: { width: 10, color: FAINT },
  bulletText: { flex: 1 },
  metrics: { flexDirection: 'row', gap: 8, marginTop: 10 },
  metric: {
    flex: 1,
    backgroundColor: TINT,
    borderRadius: 5,
    paddingVertical: 7,
    paddingHorizontal: 9,
  },
  metricValue: { fontSize: 11.5, fontWeight: 700, color: INK, lineHeight: 1.2 },
  metricLabel: { fontSize: 7.5, color: MUTED, marginTop: 1 },

  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 8 },
  pill: {
    fontSize: 7.5,
    color: BODY,
    borderWidth: 0.6,
    borderColor: RULE,
    borderRadius: 8,
    paddingVertical: 2,
    paddingHorizontal: 6,
  },

  categories: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  category: { width: '48.5%', marginBottom: 14 },
  categoryName: { fontSize: 10.5, fontWeight: 600, color: INK },
  certsTitle: {
    fontSize: 10.5,
    fontWeight: 600,
    color: INK,
    marginTop: 6,
    marginBottom: 6,
  },
  cert: {
    borderLeftWidth: 2,
    borderLeftColor: LIME,
    paddingLeft: 8,
    marginBottom: 7,
  },
  certTitle: { fontSize: 9.5, fontWeight: 600, color: INK },
  certIssuer: { fontSize: 8.5, color: MUTED },

  contactRow: { flexDirection: 'row', marginBottom: 3 },
  contactKey: { width: 60, color: MUTED },
  link: { color: INK, textDecoration: 'none' },
  closing: { marginTop: 22, fontSize: 10, fontStyle: 'italic', color: MUTED },
})

// fontSize travels with lineHeight on purpose: react-pdf resolves a unitless
// lineHeight against the font size declared in the *same* style, falling back
// to its own 18pt default — not the inherited 9.5pt — so a lone lineHeight
// here spaced every unstyled paragraph and bullet at 26pt.
const BODY_LINE: Style = { fontSize: 9.5, lineHeight: 1.45 }

/** One field's runs as nested <Text>, links as inline <Link>. */
function R({ rich, style }: { rich: Rich; style?: Style | Style[] }) {
  return (
    <Text style={[BODY_LINE, ...(Array.isArray(style) ? style : style ? [style] : [])]}>
      {rich.map((run, i) => {
        const decoration = [run.underline || run.href ? 'underline' : '', run.strike ? 'line-through' : '']
          .filter(Boolean)
          .join(' ')
        const runStyle: Style = {
          ...(run.bold ? { fontWeight: 700 } : {}),
          ...(run.italic ? { fontStyle: 'italic' } : {}),
          ...(decoration ? { textDecoration: decoration as Style['textDecoration'] } : {}),
        }
        return run.href ? (
          <Link key={i} src={run.href} style={{ ...runStyle, color: INK }}>
            {run.text}
          </Link>
        ) : (
          <Text key={i} style={runStyle}>
            {run.text}
          </Text>
        )
      })}
    </Text>
  )
}

function has(rich: Rich) {
  return !isEmptyRich(rich)
}

function SectionHead({ title, subtitle }: { title: Rich; subtitle?: Rich }) {
  // minPresenceAhead: never leave a heading alone at the bottom of a page,
  // separated from the first thing it introduces. Sized for a whole project
  // header (photo + title), the tallest unbreakable thing that follows one.
  return (
    <View style={s.sectionHead} minPresenceAhead={170}>
      <View style={s.sectionBar} />
      <R rich={title} style={s.sectionTitle} />
      {subtitle && has(subtitle) && <R rich={subtitle} style={s.sectionSubtitle} />}
    </View>
  )
}

function Cert({ cert }: { cert: { title: Rich; issuer: Rich } }) {
  return (
    <View style={s.cert} wrap={false}>
      <R rich={cert.title} style={s.certTitle} />
      {has(cert.issuer) && <R rich={cert.issuer} style={s.certIssuer} />}
    </View>
  )
}

function Photo({ image, images, style }: { image: PdfImage | null; images: Record<string, string>; style: Style }) {
  const data = image ? images[image.src] : undefined
  // A photo that couldn't be fetched or decoded is left out rather than
  // failing the whole export — see export.ts.
  if (!data) return null
  // react-pdf's <Image> has no alt prop (a PDF image has no alternative-text
  // slot in this renderer); the rule is written for DOM <img>.
  // eslint-disable-next-line jsx-a11y/alt-text
  return <Image src={data} style={style} />
}

export function PortfolioDocument({
  model,
  images,
  labels,
}: {
  model: PdfModel
  /** src → a ready-to-embed JPEG data URL (or, offline, a file path). */
  images: Record<string, string>
  labels: PdfLabels
}) {
  const { hero, stats, journey, projects, skills, contact } = model
  const hasPortrait = !!(hero.portrait && images[hero.portrait.src])
  const linkedin = contact.socials.filter((social) => social.url || social.label)

  return (
    <Document title={`${model.plainName || 'Portfolio'} — Portfolio`} author={model.plainName} language={model.lang}>
      <Page size="A4" orientation="portrait" style={s.page}>
        {/* Running footer on every page: who this is, a way back to the live
            page, and where you are in the document. */}
        <View style={s.footer} fixed>
          <Text>
            {model.plainName ? `${model.plainName} · ` : ''}
            {labels.livePortfolio}:{' '}
            <Link src={model.url} style={s.footerLink}>
              {model.url.replace(/^https?:\/\//, '')}
            </Link>
          </Text>
          <Text render={({ pageNumber, totalPages }) => `${labels.page} ${pageNumber} / ${totalPages}`} />
        </View>

        {/* Hero */}
        <View style={s.hero} wrap={false}>
          {hasPortrait && <Photo image={hero.portrait} images={images} style={s.portrait} />}
          <View style={s.heroText}>
            {has(hero.greeting) && <R rich={hero.greeting} style={s.greeting} />}
            {has(hero.name) && <R rich={hero.name} style={s.name} />}
            {has(hero.tagline) && <R rich={hero.tagline} style={s.tagline} />}
            {has(hero.description) && <R rich={hero.description} style={s.description} />}
            {(contact.email || linkedin.length > 0) && (
              <View style={s.contactLine}>
                {contact.email && (
                  <Link src={`mailto:${contact.email}`} style={s.contactItem}>
                    {contact.email}
                  </Link>
                )}
                {linkedin.map((social, i) =>
                  social.url ? (
                    <Link key={i} src={social.url} style={s.contactItem}>
                      {social.label || social.url.replace(/^https?:\/\//, '')}
                    </Link>
                  ) : (
                    <Text key={i} style={s.contactItem}>
                      {social.label}
                    </Text>
                  )
                )}
              </View>
            )}
          </View>
        </View>

        {stats.length > 0 && (
          <View style={s.stats} wrap={false}>
            {stats.map((stat, i) => (
              <View key={i} style={s.stat}>
                <R rich={stat.value} style={s.statValue} />
                <R rich={stat.label} style={s.statLabel} />
              </View>
            ))}
          </View>
        )}

        {/* Story */}
        {journey.chapters.length > 0 && (
          <View style={s.section}>
            <SectionHead title={journey.title} />
            {journey.chapters.map((chapter, i) => (
              <View key={i} style={s.chapter} wrap={false}>
                <View style={s.chapterText}>
                  {has(chapter.tag) && <R rich={chapter.tag} style={s.eyebrow} />}
                  {has(chapter.heading) && <R rich={chapter.heading} style={s.chapterHeading} />}
                  {has(chapter.body) && <R rich={chapter.body} />}
                </View>
                <Photo image={chapter.photo} images={images} style={s.chapterPhoto} />
              </View>
            ))}
          </View>
        )}

        {/* Projects */}
        {projects.items.length > 0 && (
          <View style={s.section}>
            <SectionHead title={projects.title} subtitle={projects.subtitle} />
            {projects.items.map((project, i) => {
              const eyebrow: Rich = [
                ...project.year,
                ...(has(project.year) && has(project.tag) ? [{ text: '  ·  ' }] : []),
                ...project.tag,
              ]
              return (
                <View key={i} style={[s.project, ...(i === projects.items.length - 1 ? [s.projectLast] : [])]}>
                  {/* Photo, title and the narrative stay together on one page;
                        metrics and tags (together, below) may follow on the next. */}
                  <View style={s.projectTop} wrap={false}>
                    <Photo image={project.cover} images={images} style={s.projectCover} />
                    <View style={s.projectMain}>
                      {has(eyebrow) && <R rich={eyebrow} style={s.eyebrow} />}
                      {has(project.title) && <R rich={project.title} style={s.projectTitle} />}
                      {project.narrative.map((line, j) => (
                        <View key={j} style={s.bullet}>
                          <Text style={s.bulletDot}>•</Text>
                          <R rich={line} style={s.bulletText} />
                        </View>
                      ))}
                    </View>
                  </View>
                  {/* Metrics and tags travel as one block, so a project's
                        tags never end up alone at the top of the next page. */}
                  {(project.metrics.length > 0 || project.tags.length > 0) && (
                    <View wrap={false}>
                      {project.metrics.length > 0 && (
                        <View style={s.metrics}>
                          {project.metrics.map((metric, j) => (
                            <View key={j} style={s.metric}>
                              <R rich={metric.value} style={s.metricValue} />
                              <R rich={metric.label} style={s.metricLabel} />
                            </View>
                          ))}
                        </View>
                      )}
                      {project.tags.length > 0 && (
                        <View style={s.pills}>
                          {project.tags.map((tag, j) => (
                            <R key={j} rich={tag} style={s.pill} />
                          ))}
                        </View>
                      )}
                    </View>
                  )}
                </View>
              )
            })}
          </View>
        )}

        {/* Skills */}
        {(skills.categories.length > 0 || skills.certs.length > 0) && (
          <View style={s.section}>
            <SectionHead title={skills.title} subtitle={skills.subtitle} />
            <View style={s.categories}>
              {skills.categories.map((category, i) => (
                <View key={i} style={s.category} wrap={false}>
                  <R rich={category.name} style={s.categoryName} />
                  {category.skills.length > 0 && (
                    <View style={s.pills}>
                      {category.skills.map((skill, j) => (
                        <R key={j} rich={skill} style={s.pill} />
                      ))}
                    </View>
                  )}
                </View>
              ))}
            </View>
            {skills.certs.length > 0 && (
              <View>
                {/* The heading rides with the first certification in one
                    unbreakable block — minPresenceAhead on a lone Text didn't
                    stop it being stranded at the bottom of a page. */}
                <View wrap={false}>
                  <Text style={s.certsTitle}>{labels.certifications}</Text>
                  <Cert cert={skills.certs[0]} />
                </View>
                {skills.certs.slice(1).map((cert, i) => (
                  <Cert key={i} cert={cert} />
                ))}
              </View>
            )}
          </View>
        )}

        {/* Contact */}
        {(has(contact.title) || contact.available.length > 0 || contact.email || linkedin.length > 0) && (
          <View style={s.section} wrap={false}>
            <SectionHead title={contact.title} subtitle={contact.subtitle} />
            {contact.available.map((item, i) => (
              <View key={i} style={s.bullet}>
                <Text style={s.bulletDot}>•</Text>
                <R rich={item} style={s.bulletText} />
              </View>
            ))}
            <View style={{ marginTop: contact.available.length > 0 ? 10 : 0 }}>
              {contact.email && (
                <View style={s.contactRow}>
                  <Text style={s.contactKey}>{labels.email}</Text>
                  <Link src={`mailto:${contact.email}`} style={s.link}>
                    {contact.email}
                  </Link>
                </View>
              )}
              {linkedin.map((social, i) => (
                <View key={i} style={s.contactRow}>
                  <Text style={s.contactKey}> </Text>
                  {social.url ? (
                    <Link src={social.url} style={s.link}>
                      {social.label || social.url.replace(/^https?:\/\//, '')}
                    </Link>
                  ) : (
                    <Text>{social.label}</Text>
                  )}
                </View>
              ))}
            </View>
            {has(model.closing) && <R rich={model.closing} style={s.closing} />}
          </View>
        )}
      </Page>
    </Document>
  )
}
