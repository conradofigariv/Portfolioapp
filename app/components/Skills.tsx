'use client'

import { useLang } from '../context/LanguageContext'
import { usePairedBlockList } from '../lib/editor/usePairedBlockList'
import { plainTextFromDoc } from '../lib/editor/render-html'
import RichText from './editor/EditableText'
import SkillCategoryCard from './SkillCategoryCard'
import CertificationCard from './CertificationCard'
import { AddButton } from './EditControls'
import { deleteSkillCategoryData, removeCertificationFile } from '../lib/portfolio-actions'

const CERT_FIELDS = ['title', 'issuer'] as const

function newSkillCategoryId() {
  return `skillcat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

export default function Skills() {
  const { t, content, editing, updateActive, lang, blocks } = useLang()
  const s = content.skills
  const {
    items: certs,
    add: addCert,
    remove: removeCert,
    busy: certsBusy,
    error: certsError,
  } = usePairedBlockList({ prefix: 'skills.certs', fields: CERT_FIELDS, section: 'skills' })

  return (
    <section id="skills" className="bg-dark-800/40 section-padding">
      <div className="container-main">
        <h2 className="heading-md mb-4">
          <RichText blockKey="skills.title" section="skills" placeholder="Section title" />
        </h2>
        <div className="text-dark-400 text-base md:text-lg mb-6 md:mb-8 max-w-2xl">
          <RichText blockKey="skills.subtitle" section="skills" placeholder="Subtitle" />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-6">
          {s.categories.map((cat) => (
            <SkillCategoryCard
              key={cat.id}
              category={cat}
              onRemove={() => {
                updateActive((c) => ({
                  ...c,
                  skills: {
                    ...c.skills,
                    categories: c.skills.categories.filter((cc) => cc.id !== cat.id),
                  },
                }))
                // Same reasoning as removeProject/removeChapter: the array
                // removal above only persists on the next Save, but this
                // category's migrated name field and nested skills live in a
                // table Save never touches — clean them up now. Only the
                // active language's blocks, matching updateActive's own
                // scope above (categories aren't synced across languages).
                void deleteSkillCategoryData(cat.id, lang)
              }}
            />
          ))}

          {editing && (
            <div className="flex items-center justify-center rounded-xl border border-dashed border-dark-700 p-4 md:p-6">
              <AddButton
                label="Add category"
                onClick={() =>
                  updateActive((c) => ({
                    ...c,
                    skills: {
                      ...c.skills,
                      categories: [...c.skills.categories, { id: newSkillCategoryId(), category: '', skills: [] }],
                    },
                  }))
                }
              />
            </div>
          )}
        </div>

        {/* Certifications */}
        <div className="mt-8 md:mt-16 pt-8 md:pt-16 border-t border-dark-700">
          <h3 className="text-lg md:text-xl font-semibold mb-6 md:mb-8 text-dark-50">{t.skills.certifications}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-6">
            {certs.map((cert) => (
              <CertificationCard
                key={cert.itemId}
                certId={cert.itemId}
                title={plainTextFromDoc(blocks[cert.blockKeys.title]?.[lang]?.json)}
                removing={certsBusy}
                onRemove={() => {
                  removeCert(cert.itemId)
                  // Same reasoning as removing a project/chapter/category: the
                  // block removal above never touches portfolio_media, so this
                  // certification's uploaded file would be orphaned under an id
                  // nothing can reference again.
                  void removeCertificationFile(cert.itemId)
                }}
              >
                <h4 className="font-semibold text-dark-50 mb-1 text-xs md:text-sm leading-snug">
                  <RichText blockKey={cert.blockKeys.title} section="skills" placeholder="Certification" />
                </h4>
                <div className="text-dark-400 text-xs">
                  <RichText blockKey={cert.blockKeys.issuer} section="skills" placeholder="Issuer" />
                </div>
              </CertificationCard>
            ))}
          </div>
          {editing && (
            <div className="mt-4">
              <AddButton label="Add certification" disabled={certsBusy} onClick={addCert} />
            </div>
          )}
          {certsError && <p className="text-xs text-red-400 mt-2">{certsError}</p>}
        </div>
      </div>
    </section>
  )
}
