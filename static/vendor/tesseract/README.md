# Local Danish recognition assets

Tesseract.js 7.0.0 and Tesseract.js-core 7.0.0 are pinned official npm packages.
The Danish model is `@tesseract.js-data/dan` 1.0.0,
`4.0.0_best_int/dan.traineddata.gz` (LSTM-only integer model).

`integrity.json` records the npm archive URLs and SHA-512 integrity values,
verified before extracting the original published assets. It also records
SHA-256 values and byte sizes for each bundled file. The language source license
is copied from the pinned `naptha/tessdata` commit recorded in that manifest.

The JavaScript wrapper and worker/core licenses are Apache-2.0. Additional
bundled dependency notices are retained beside the minified scripts. The npm
language-package metadata declares MIT, while its upstream trained-data source
is Apache-2.0; the model source license is included in `lang/LICENSE`.

Recognition loads only the local ESM API, worker, one compatible WebAssembly
core, and Danish model. All supported core variants are retained so browsers
can choose a compatible SIMD or baseline build. No CDN, language cache,
IndexedDB, or external OCR service is used by the reader configuration.
