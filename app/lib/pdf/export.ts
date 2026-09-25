import { parseObjectPosition, pdfFileName, type PdfImage, type PdfModel } from './model'
import type { PdfLabels } from './PortfolioDocument'

/**
 * Build the PDF in the browser and hand it to the visitor as a download.
 *
 * Client-side on purpose: the page already holds everything the document
 * needs (content, blocks, media — including an owner's not-yet-saved edits),
 * the browser can decode every image format this app stores (react-pdf itself
 * only embeds JPEG and PNG, and uploads here are WebP), and there's no
 * serverless time limit to race on a long portfolio.
 *
 * react-pdf and the document are imported *inside* this function, so they're
 * a separate chunk fetched on the first click — a visitor who never downloads
 * never loads them.
 */

// Photos are drawn at up to this many device pixels per PDF point: sharp when
// printed, without embedding a 4000px original for a 130pt thumbnail.
const PIXELS_PER_POINT = 2.5
// The widest box any photo lands in (PortfolioDocument's project cover), in points.
const MAX_BOX_WIDTH = 170
const JPEG_QUALITY = 0.86

/**
 * Fetch one photo, crop it to its box's aspect exactly where the page crops it
 * (its CSS object-position), and re-encode it as a JPEG data URL. Returns null
 * rather than throwing: one photo that can't be fetched (moved, CORS, a format
 * this browser can't decode) must not cost the owner the whole PDF.
 */
async function prepareImage(image: PdfImage): Promise<string | null> {
  try {
    const response = await fetch(image.src, { mode: 'cors' })
    if (!response.ok) return null
    const bitmap = await createImageBitmap(await response.blob())
    const { width: w, height: h } = bitmap
    const { x, y } = parseObjectPosition(image.position)

    // The same window `object-fit: cover` shows: the full width or height,
    // whichever is short relative to the box, slid along the other axis.
    let cropW = w
    let cropH = h
    if (w / h > image.aspect) cropW = h * image.aspect
    else cropH = w / image.aspect
    const sx = (w - cropW) * x
    const sy = (h - cropH) * y

    const outW = Math.round(Math.min(cropW, MAX_BOX_WIDTH * PIXELS_PER_POINT))
    const outH = Math.round(outW / image.aspect)
    const canvas = document.createElement('canvas')
    canvas.width = outW
    canvas.height = outH
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    // JPEG has no alpha: a transparent PNG would otherwise come out black.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, outW, outH)
    ctx.drawImage(bitmap, sx, sy, cropW, cropH, 0, 0, outW, outH)
    bitmap.close()
    return canvas.toDataURL('image/jpeg', JPEG_QUALITY)
  } catch {
    return null
  }
}

export async function exportPortfolioPdf(options: {
  model: PdfModel
  labels: PdfLabels
  /** Used for the file name when the portfolio has no name filled in. */
  username: string
}): Promise<void> {
  const { model, labels, username } = options

  const [{ pdf }, { PortfolioDocument, registerPdfFonts }] = await Promise.all([
    import('@react-pdf/renderer'),
    import('./PortfolioDocument'),
  ])
  registerPdfFonts(`${window.location.origin}/fonts/inter`)

  const wanted = [
    model.hero.portrait,
    ...model.journey.chapters.map((chapter) => chapter.photo),
    ...model.projects.items.map((project) => project.cover),
  ].filter((image): image is PdfImage => image !== null)

  // Keyed by src: the same photo can appear twice (a chapter and a project
  // sharing one), and it only needs fetching once.
  const unique = [...new Map(wanted.map((image) => [`${image.src}|${image.aspect}|${image.position}`, image])).values()]
  const images: Record<string, string> = {}
  await Promise.all(
    unique.map(async (image) => {
      const data = await prepareImage(image)
      if (data) images[image.src] = data
    })
  )

  const blob = await pdf(PortfolioDocument({ model, images, labels })).toBlob()

  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = pdfFileName(model, username)
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Revoked on a delay, not immediately: some browsers start reading the blob
  // after click() returns, and revoking first cancels the download.
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
