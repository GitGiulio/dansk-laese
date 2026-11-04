# Dansk

A static Danish reader with contextual English, Italian, and Polish meanings. Paste text
or open TXT, DOCX, or PDF. PDFs keep their original appearance. Meanings prepare
in the background; hovering shows a small translation-only box instantly when
ready. Hovering unprepared text never sends an extra request. Selecting text and pressing
**Translate selection** explicitly requests its full translation when needed.

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
Get a key from [Groq Console](https://console.groq.com/keys). The browser calls
Groq directly with your key. This version does not read `.env`; your existing
private file is kept for optional Python evaluation tools only.

## Accounts

Readers choose a unique username and password; no email address is requested.
Names use 3 to 24 letters, digits or underscores and are case insensitive. Signup
checks availability and offers a clickable small variation when a name is taken.
Supabase still manages passwords and stores only the encrypted Groq key.

One-time owner setup is required in your existing Supabase project:

1. Run [`supabase/usernames.sql`](supabase/usernames.sql) in its SQL Editor.
2. In Authentication > Providers > Email, disable **Confirm email**. Keep the
   Email provider enabled because Supabase uses generated internal identifiers.

Your supplied public project configuration is already in `static/config.js`.
The public key cannot run SQL or change authentication settings. No private key
belongs in the app. Until this setup is applied, API-key entry works and username
signup explains the missing configuration. No signup emails or SMTP are needed.
See [`docs/accounts.md`](docs/accounts.md) for details and recovery limitations.

## GitHub Pages

1. Put this project in a GitHub repository. Keep `.env`, `.venv`, `test-results`,
   `.cache`, and user documents out of commits. The included `.gitignore` covers
   development artifacts and the private `.env`.
2. In repository **Settings > Pages**, select **GitHub Actions** as the source.
3. Run **Deploy Dansk to GitHub Pages** manually from the Actions tab.
4. Complete the username account setup above.

The workflow tests and builds only public assets from `static/`, then publishes
`dist/`. It does not publish Python files, tests, documents, or `.env`. Relative
asset and PDF-worker URLs support repository paths such as
`https://YOUR_USER.github.io/DanskReadingApp/`. No GitHub Secrets or Groq key is
needed for deployment. The build rejects likely embedded private credentials.

```powershell
npm run build
npm run preview
```

You can also deploy the contents of `dist/` to any static HTTPS host. See
[GitHub's custom Pages workflow guide](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## Reading and privacy

- Documents and prepared meanings stay in tab memory. Refresh or disconnect
  clears the session. No localStorage, sessionStorage, cookies, or database is
  used by the reader to persist documents or unlocked keys.
- Preparing sends the document in chunks of up to 60 target words and 2,000
  context characters to Groq, in the chosen language. The model is
  `openai/gpt-oss-120b`. It handles idioms and separated expressions by source-word
  IDs. It does not guarantee every meaning is correct.
- Prepared words and recognized expression selections have instant meanings.
  Other selections offer an explicit full-translation request (up to 2,000 context
  characters), cached in memory; a loading box appears while waiting. Click to pin, Escape to close; use arrow keys and Enter for keyboard
  reading. English, Italian, and Polish prepare and cache separately.
- One request runs at a time, with a 15-second timeout and pacing based on token
  usage. Errors pause preparation; **Retry** respects quota cooldowns. Reading
  and cached meanings remain usable. The app never switches providers or plans. Explicit selection requests wait for
  the current background request and provider pacing, then temporarily take priority.
- PDFs use local PDF.js canvas rendering and a selectable text layer. Page and
  zoom controls preserve the original layout. Scans need prior OCR for meanings;
  encrypted PDFs need an unencrypted copy. Complex column order may need a
  corrected **Text view**. PDF bytes stay in browser memory.
- Imports are limited to 10 MiB. Text is limited to 200,000 characters, including
  per-page PDF context and the complete optional PDF text view. TXT supports
  UTF-8, BOM-marked UTF-16, and Windows-1252 fallback. DOCX extracts text only;
  legacy `.doc` needs conversion. DOCX expanded ZIP size is limited to 50 MiB.
- Libraries are bundled locally: Mozilla PDF.js 6.5.438 (Apache 2.0) and Mammoth
  1.13.0 (BSD-2-Clause). Their licenses are included under `static/vendor/`.
- The running app handles your unlocked key. Trust the deployed site and your
  Supabase project administrators. Never put a Groq key or Supabase secret key
  in public configuration or a GitHub commit.

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
under a repository-style prefix, and mocked Groq/Supabase responses. They never
use your key, create real accounts, or send email. Screenshots go in ignored
`test-results/`. No real GitHub Pages deployment is performed by the tests.

The original Python endpoints remain for development and evaluation; the static
reader never calls them. An opt-in 12-case, two-language evaluation is available:

```powershell
uv run --env-file .env python evaluate.py --live
```

This sends real requests using `.env` and writes `evaluation-results.json` for
manual semantic review. Passing software tests does not establish Danish
translation quality. The full 24-lookup quality evaluation has not been run for
this conversion; no provider or model has been changed.

The schema-error fix was checked against a live 57-word English preparation:
all target words were covered and no blank translations were accepted. Requests
now supply explicit source IDs, rather than asking the model to count array
positions. This improved alignment in the sample. Semantic errors remained in
some fixed expressions, including `kan godt lide` and `i går`; expression
boundaries and Danish accuracy still need the separate manual quality review.
