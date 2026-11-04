# Original PDF view and compact translations

Approved change: PDF uploads open with the original page layout, hover translation,
zoom and page navigation. Keep an optional extracted-text view. Translation tooltips
contain only the translated meaning in a small box directly above the target.

Implementation:
- Bundle Mozilla PDF.js locally, including worker, fonts, CMaps and license.
- Keep PDF bytes in browser/worker memory. Render one page at a time onto a canvas
  with the matching transparent text layer. Never reconstruct the visible page.
- Group text geometrically into local blocks, avoiding cross-column context; map
  stable source word offsets back to the transparent text layer, including words
  split between PDF text runs. Reuse the existing translation endpoint and cache.
- Reuse reading interactions for both views; use PDF zoom instead of font sizing.
- Keep loading/errors outside the translation-only tooltip. If the target is too
  near the viewport top, place the box just below it to keep the meaning readable.
- Invalidate pending UI updates on page, zoom, mode and document changes; release
  PDF worker/render tasks when a document is replaced.

Verification: pure layout/offset tests, existing Python and JavaScript checks,
real Chrome tests of original PDF pages, word mapping, columns, zoom, navigation,
view switching and the size/content/position of the tooltip. Inspect screenshots.

Completed: dependency bundling, geometric mapping, original page rendering,
compact tooltips, text-view fallback, navigation, zoom and mobile fit-width.

Review corrections, each reproduced with a failing browser check before fixing:
- Hide PDF navigation immediately during a text-view transition.
- Reposition pinned tooltips on horizontal PDF-container scrolling.
- Invalidate lookups started on an old page while its replacement was loading.
- Preserve edited fallback text across view changes.

Geometry and offset checks also cover split PDF text runs, columns, headings and
Unicode. Visual checks use an in-memory test PDF with colored graphics, different
font sizes, two columns and a rotated second page. Application documents are not
written to disk, and test screenshots are kept in the ignored test-results folder.
