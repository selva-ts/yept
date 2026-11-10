// PDF pages as PNG images for the response preview. pdf.js parses the file in a worker and draws each page on a canvas
// here; only the images go into the sandboxed preview frame, so nothing from the PDF runs or loads anything there.
// Chromium's own PDF viewer does not work in a fully sandboxed frame, which is why the pages are drawn instead.
import { getDocument, PDFWorker } from 'pdfjs-dist';
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker';

/** Pages drawn at most; the preview says when there are more. */
export const PDF_MAX_PAGES = 30;
const SCALE = 1.5;
// A page larger than this (in pixels, after scaling) is drawn smaller.
const MAX_PIXELS = 16_000_000;

export interface RenderedPdf {
  pages: string[];
  pageCount: number;
}

export async function renderPdf(bytes: Uint8Array): Promise<RenderedPdf> {
  const worker = new PDFWorker({ port: new PdfWorker() as never });
  const task = getDocument({
    data: bytes,
    worker,
    // Nothing is fetched: no standard font files, colour profiles, character maps or WebAssembly decoders. Pages that
    // need them draw with system fonts, or without the image that needed a decoder.
    useSystemFonts: true,
    useWasm: false,
    enableXfa: false,
    stopAtErrors: false,
    verbosity: 0
  });
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    for (let n = 1; n <= Math.min(doc.numPages, PDF_MAX_PAGES); n++) {
      const page = await doc.getPage(n);
      let viewport = page.getViewport({ scale: SCALE });
      const pixels = viewport.width * viewport.height;
      if (pixels > MAX_PIXELS) viewport = page.getViewport({ scale: SCALE * Math.sqrt(MAX_PIXELS / pixels) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
      pages.push(canvas.toDataURL('image/png'));
      page.cleanup();
    }
    return { pages, pageCount: doc.numPages };
  } finally {
    await task.destroy();
    worker.destroy();
  }
}
