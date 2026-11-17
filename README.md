# Dansk

A static Danish reader with contextual English, Italian, and Polish meanings. Paste text
or open TXT, DOCX, PDF, PNG, JPEG, or WebP. PDFs and images keep their original appearance. Meanings prepare
in the background; hovering shows a small translation-only box instantly when
ready. Hovering unprepared text never sends an extra request. Selecting text and pressing
**Translate selection** explicitly requests its full translation when needed.

## GitHub Pages
The app is available on [GitHub Pages](https://gitgiulio.github.io/dansk-laese/).
Use a personal API key for the current tab or create an account to save it encrypted.

## Run locally on Windows

If you already have this project's Python environment, no Node installation is
needed for a local preview. Run from this project folder:

```powershell
.\.venv\Scripts\python.exe -m http.server 8000 --bind 127.0.0.1 --directory static
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000). Stop with Ctrl+C. This
serves only the public `static` folder, so `.env` is not exposed.

Alternatively, to use the Node build and preview commands:

Install [Node.js 24 LTS](https://nodejs.org/), then run in this folder:

```powershell
npm run dev
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000). Stop with Ctrl+C.
There are no npm dependencies to install and no Python backend required. The
preview server serves only the generated `dist` folder, never the project root.
The app is left stopped after development checks.

If PowerShell finds `npm.ps1` but reports that `node.exe` is not recognized,
install or repair Node.js using its Windows installer, then reopen your terminal
(and restart PyCharm if using its terminal). Check `node --version` before
retrying `npm run dev`. The Node runtime bundled with Codex is available to the
agent's tools but does not install Node for your normal terminal.

Choose **API key** for a one-tab session, **Log in**, or **Create account**.
Get a personal key from [Groq Console](https://console.groq.com/keys) or
[Google AI Studio](https://aistudio.google.com/api-keys). The browser calls the
selected provider directly. The optional Python tools use `.env` separately.
Use **Add key** to enter up to eight masked keys, and **Manage keys** to edit them
later. The list can include one Gemini key. Pick the provider if the app cannot
identify a key’s format. **Show/Hide** reveals a key for identification and
**Remove** deletes a row.
Press **Continue**, with **Save encrypted keys to my account** checked, to save
the updated list. At least one key is required to continue reading.
Gemini is selected by default when present. To use Groq in a mixed connection,
choose it under **Translation provider** in **Manage keys**. This choice applies
to the current session.

Your Google project controls Gemini quota and any charges. Projects on the
Gemini Free Tier have limited access to eligible models. Usage on a paid project
can incur charges for the same models. Google’s terms specify additional conditions
for apps made available to users in the EEA, Switzerland, and the UK.
[Gemini billing](https://aistudio.google.com/docs/billing) · [Gemini API terms](https://aistudio.google.com/docs/terms#use-restrictions)

## Accounts

Readers choose a unique username and password; no email address is requested.
Names use 3 to 24 letters, digits or underscores and are case insensitive. Signup
checks availability and offers a clickable small variation when a name is taken.
Supabase manages passwords and stores the encrypted API-key list, any manual key
classifications, and the legacy quota preference. Existing accounts and single-key vaults remain valid without
migration or changes to the Supabase setup. Multi-key vaults use a new encrypted
format only when saved; login never rewrites an existing vault.

Account sign-in survives refresh and browser reopening. IndexedDB remembers the
Supabase access/refresh tokens and a non-exportable vault-unlocking CryptoKey,
without saving the password or plaintext API keys. The app verifies the account
with Supabase on restoration and refreshes expired tokens. **Log out** removes
the remembered session, including when the remote logout request fails. Existing
users only need to log in once after this update; no account migration is needed.

One-time owner setup is required in your existing Supabase project:

1. Run [`supabase/usernames.sql`](supabase/usernames.sql) in its SQL Editor.
2. In Authentication > Providers > Email, disable **Confirm email**. Keep the
   Email provider enabled because Supabase uses generated internal identifiers.

Your supplied public project configuration is already in `static/config.js`.
The public key cannot run SQL or change authentication settings. No private key
belongs in the app. Until this setup is applied, API-key entry works and username
signup explains the missing configuration. No signup emails or SMTP are needed.
See [`docs/accounts.md`](docs/accounts.md) for details and recovery limitations.



## Reading and privacy

- Documents and prepared meanings stay in tab memory. Refresh or disconnect
  clears them. Account sign-in is remembered separately in IndexedDB; documents,
  translations, passwords and plaintext API keys are never written there.
  Direct API-key entry without an account remains limited to the current tab.
- Preparing sends the document in chunks of up to 48 target words with nearby
  context (normally up to 800 characters, adjusted to fit the request budget) to the
  selected provider. Both providers use source-word IDs for idioms and separated expressions.
  Short paragraphs, including OCR text blocks, share a request where possible,
  while retaining separate source offsets and expression boundaries.
- Prepared words and recognized expression selections have instant meanings.
  Other selections offer an explicit full-translation request (up to 2,000 context
  characters), cached in memory; a loading box appears while waiting. Click to pin, Escape to close; use arrow keys and Enter for keyboard
  reading. English, Italian, and Polish prepare and cache separately.
- Groq uses `openai/gpt-oss-120b` and can prepare concurrently with one request per key.
  Explicit selections wait for active preparation and then take priority.
  The visible page and the top visible word take
  priority after any request already in flight. Scrolling reprioritizes queued work,
  including chunks still waiting for token allowance.
- Each Groq key has its own budget of 8,000 tokens per rolling minute. Budget state
  survives key editing and document changes, indexed by key fingerprints rather
  than retained plaintext credentials. Each request reserves its
  estimated complete JSON input plus maximum output, with a 7,200-token request
  ceiling. Input estimates use UTF-8 bytes divided by three plus chat overhead;
  they are estimates, not an exact model tokenizer. Actual usage replaces estimates
  when returned, and exposed provider remaining/reset headers also constrain work.
  Valid cached input tokens are excluded from quota accounting. There is no extra
  per-request delay; the progress text identifies waits for token allowance.
  Background preparation, selection requests and corrective retries share this
  budget. Waiting is cancellable and does not count toward the 15-second HTTP
  timeout. Other tabs and applications can also consume the provider account quota.
- Gemini prepares one batch at a time. Its starting model is `gemini-4-hydrogen`,
  followed by `gemini-3.8-flash` and `gemini-3.1-flash-lite` on model-level quota
  errors, all using the same personal key. A model becomes eligible again when
  its cooldown expires. If the available models are limited, the reader shows
  when to retry. Reading and cached meanings remain usable while preparation is paused.
- PDFs use local PDF.js canvas rendering and a selectable text layer. Page and
  zoom controls preserve the original layout. Scanned pages automatically receive
  Danish OCR, performed locally in a bundled WebAssembly worker. Native selectable
  PDF text is retained when usable; sparse image pages also receive recognition.
  **Recognize page** retries OCR or handles an incomplete existing text layer.
  Encrypted PDFs need an unencrypted copy. Complex column order may need a
  corrected **Text view**. PDF bytes stay in browser memory.
- PNG, JPEG, and WebP images open as single-page documents with the original
  colors/layout and transparent selectable word boxes. OCR uses Danish source text,
  preserves paragraph/line boundaries, and feeds the existing English, Italian, or
  Polish translation queue. Recognition runs locally without API usage.
  The visible page is processed first, then remaining PDF pages. Zoom reuses
  recognized text and boxes instead of scanning again. Recognition results and
  source pixels stay in tab memory; no external OCR service or CDN is contacted.
- OCR can misread small, blurred, handwritten, or complex photographed text. Use
  **Text view** and **Edit text** to correct extracted text for reading, or retry
  with a clearer source. These edits do not rewrite the original image/PDF.
- Imports are limited to 10 MiB. Text is limited to 200,000 characters, including
  per-page PDF/image context and the complete optional text view. Image metadata
  above 40 million pixels or 32,767 pixels per side is rejected before decoding;
  recognition rasters and rendered canvases have separate bounded pixel limits. TXT supports
  UTF-8, BOM-marked UTF-16, and Windows-1252 fallback. DOCX extracts text only;
  legacy `.doc` needs conversion. DOCX expanded ZIP size is limited to 50 MiB.
- Libraries are bundled locally: Mozilla PDF.js 6.5.438 (Apache 2.0) and Mammoth
  1.13.0 (BSD-2-Clause). Their licenses are included under `static/vendor/`. OCR uses Tesseract.js 7.0.0,
  its 7.0.0 WebAssembly core, and Danish model package 1.0.0 under Apache 2.0;
  vendored archives are integrity-checked and recorded in
  `static/vendor/tesseract/integrity.json`.
- The running app handles your unlocked key. Trust the deployed site and your
  Supabase project administrators. Keep API secrets out of public configuration
  and GitHub commits.

## Verification

```powershell
npm test
uv sync --locked
uv run pytest -q
$env:RUN_BROWSER_TESTS = "1"
uv run pytest tests/test_browser.py -q
```

The Python tools are optional development dependencies. Browser checks use an
installed Chrome (`BROWSER_EXECUTABLE` can override its path), a static server
under a repository-style prefix, and mocked Groq, Gemini, and Supabase responses. They never
use your key, create real accounts, or send email. Screenshots go in ignored
`test-results/`. No real GitHub Pages deployment is performed by the tests.

The original Python endpoints remain for development and evaluation; the static
reader never calls them. An opt-in 12-case, two-language evaluation is available:

```powershell
uv run --env-file .env python evaluate.py --live
```

This sends real requests using `.env` and writes `evaluation-results.json` for
manual semantic review. Passing software tests does not establish Danish
translation quality. Gemini’s model ranking is an initial default. To smoke-test
the live Gemini connection, open the local static preview, enter a personal
AI Studio key, and read a short sample passage. The browser’s Network panel should
show a successful model-list check and a structured Interactions response.
Use the passages in [`evaluation/cases.json`](evaluation/cases.json) to review
idioms and source-word coverage across models before changing the ranking.

The schema-error fix was checked against a live 57-word English preparation:
all target words were covered and no blank translations were accepted. Requests
now supply explicit source IDs, rather than asking the model to count array
positions. This improved alignment in the sample. Semantic errors remained in
some fixed expressions, including `kan godt lide` and `i går`; expression
boundaries and Danish accuracy still need the separate manual quality review.
