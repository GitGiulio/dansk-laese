# Background contextual meanings

Historical initial implementation record. Current static-reader chunk sizing,
visible-text priority, explicit selections, and 8,000-token budget are described
in [the README](../README.md).

Approved behavior: start reading immediately while contextual meanings prepare in
the background. Hover, click, keyboard lookup and phrase selection MUST NOT make
ad-hoc translation requests, including when the target is not ready.

Approach: prepare up to 60 target words per chunk, with surrounding paragraph
context of at most 2,000 characters. One structured response supplies concise
word/expression meanings keyed to source token IDs. Validate exact target coverage,
source IDs, nonempty meanings and duplicate/overlapping target assignments.
Expressions may include separated words and context outside a chunk boundary.

Add POST /api/prepare using the existing context/start/end/language request shape.
Return validated entries with source highlight ranges and a suggested delay based
on actual token use at the published free-tier budget. Allow one corrective retry
for an invalid response, a 45-second overall preparation timeout, and no automatic
error retry loop. Provider failures pause preparation with an explicit Retry button.

Use a session-only preparation queue and result index by exact paragraph text,
language, model and prompt version. The current PDF page takes priority; discover
and queue remaining page text without rendering it. Reuse results across pages,
zoom and view changes. Language changes prioritize that language and preserve old
results; document edits/replacement cancel pending preparation and reset the index.

Every source word is mapped to its contextual word or expression meaning. Single
word lookups are immediate local reads. A selected phrase must exactly match a
prepared source group; arbitrary selections do not concatenate word meanings or
request new translations. Unprepared hovers stay open logically and display their
meaning if preparation completes while the pointer remains on the target.

Keep progress, unavailable-selection feedback and errors outside the small
translation-only tooltip. The old single-lookup API remains available for the
explicit command-line quality evaluation, but the browser never calls it.

Checks: mock provider coverage/schema failures; queue prioritization, pacing and
pause/retry; no requests from cache reads; stale/language/document invalidation;
real-browser tests for unprepared hover, prepared hover, selections and PDF pages.
Live Groq evaluation is opt-in; implementation tests never send a user's text/key.

Implemented and independently reviewed. Browser fixtures reject any call to the
legacy on-demand endpoint. Regression checks cover late completion after pointer
departure, mobile status layout stability, document/language changes, cooldown
preservation, PDF page priority, prepared selections and unavailable selections.
The import screen now discloses automatic background processing of document text.

Verification uses headless Chrome outside the restricted sandbox because Python
event-loop creation stalls inside it. A single live preparation smoke check with
the configured key returned a valid contextual English meaning and complete source
coverage for "Det er lige meget." This is not a full linguistic accuracy benchmark.

Current static reader performance: chunks target at most 48 words. Short paragraphs
from one enqueue group share a request, separated by blank lines. Returned source
ranges map back to each paragraph's Unicode offsets; expressions cannot cross those
paragraph boundaries. Interrupted or failed batches restore all constituent jobs.
Only the shared rolling token budget delays requests, with no additional linear
delay after responses. Progress explicitly distinguishes token-budget waits.
Numeric request, wait and usage totals remain in memory for diagnostics, without
logging document contents. A synthetic 365-word, 61-paragraph reproduction uses
8 requests instead of 61, with 77% less estimated input overhead. This is a request
count and token-estimate comparison, not a live translation-speed guarantee.
