// Shared by the browser (upload-cv.ts) and the server (read-cv.ts), so it lives
// on its own: importing it must never pull the Gemini SDK into a client bundle.

/** Keeps the request under Gemini's inline limit once base64 adds a third. */
export const MAX_CV_BYTES = 8 * 1024 * 1024
