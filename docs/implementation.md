# Danish reader implementation record

Historical implementation plan. The current static app and account setup are
documented in [static-app.md](static-app.md) and [the README](../README.md).

Approved scope: local FastAPI + plain browser UI; Groq; pasted/TXT/DOCX/searchable PDF;
English and Italian; session-only state; 300 ms hover; 2,000-character context;
10 MiB uploads; 200,000-character documents. No OCR, legacy DOC, database or hosting.

Tasks:
1. Translation contract, curated cases and opt-in live evaluation.
2. In-memory extraction, normalized text and stable occurrence identifiers.
3. Accessible reader, preview, hover, phrase selection and session cache.
4. Integration/browser verification, documentation and independent review.

Ruling: no Groq key exists in the environment. Live quality evaluation is blocked,
so implement the approved model unchanged and supply an opt-in evaluation command.
Do not describe mocked API tests as evidence of linguistic accuracy.

Ruling: workspace is empty and has no project Git repository. Work directly in the
requested folder; do not initialize Git or create a worktree in an unrelated parent.

Completed:
- Translation contract, 12 curated cases in both languages and opt-in evaluator.
- In-memory file extraction, editable preview and stable Unicode word identifiers.
- Desktop/mobile reader with hover, pinning, keyboard, selection and language switch.
- Session cache, request serialization, stale-response protection and cooldowns.
- API, JavaScript and real-Chrome checks; screenshots inspected at both sizes.

Independent review found two important issues, both reproduced by failing tests
before correction: blank paragraph filtering could create identifier gaps, and
the answer schema could not represent long selections accepted by the UI.
Paragraph numbering is now contiguous; the schema covers the maximum 1,000 words
possible in a 2,000-character excerpt, with an output budget scaled to selection size.
Character offsets are kept local rather than sent redundantly to the model.

Ruling: live evaluation without GROQ_API_KEY exits explicitly with no network calls.
No claims of Danish linguistic accuracy are made. Account quota may still limit
long lookups; failures remain actionable and do not interrupt reading.

Final verification commands:
- RUN_BROWSER_TESTS=1 .venv/Scripts/python.exe -m pytest -q
- node --test tests/reader.test.mjs
- uv sync --locked --offline
- Python compilation and node --check static/app.js

One third-party warning remains: Starlette's test client deprecates its httpx
backend in favor of httpx2. It does not affect the app runtime or test outcomes.
