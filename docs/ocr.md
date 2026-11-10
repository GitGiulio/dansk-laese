# OCR for the static reader

Requested behavior: recognize Danish text in images and scanned PDFs, retaining
the original page appearance and existing word/selection translations.

Implementation choice: Tesseract.js with a bundled Danish model and WebAssembly
worker, loaded only when recognition is needed. Recognition runs locally and
uses no Groq tokens. Source images and OCR results remain in session memory.

The reader accepts PNG, JPEG, and WebP images as single-page documents. A PDF
keeps its existing selectable text when usable; pages without useful text receive
OCR individually. A manual recognition action covers pages with incomplete or
unusable text layers. Recognition retains paragraph boundaries and word boxes,
mapped to the same occurrence identifiers used by the translation cache.
Automatic page segmentation detects columns and text blocks instead of treating
the page as a single block, keeping unrelated dialogue lines out of one paragraph.

The visible page is recognized before continuing through remaining pages. Use
one worker per document and release it when the document closes. Cache page text
and word boxes, not page-sized OCR canvases. Bound OCR raster resolution and
render memory. Document replacement, page changes, zoom, and worker failures must
not attach results to the wrong document or leave reading unusable.

Retain the original canvas/image and overlay transparent selectable word boxes.
Zoom rescales boxes without rerunning recognition. The optional editable text
view provides a way to correct recognition errors. A short progress status and
retry action make recognition failures actionable. Existing 10 MiB import limits,
text-size limits, and the shared 8,000-token translation budget still apply.

Verify mapping and cancellation with unit/mocked browser checks, then exercise
the actual bundled OCR worker on clear Danish text rendered into an image and an
image-only PDF. Check alignment, zoom, selection, original colors/layout, local
resource URLs under a repository prefix, and absence of external OCR traffic.
OCR accuracy depends on image quality; handwritten and complex photographed
layouts need separate evaluation.
