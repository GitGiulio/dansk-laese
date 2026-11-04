# Static Dansk app

Approved: convert the reader to a fully static GitHub Pages app. Retain original
PDF rendering, TXT/DOCX imports, background contextual meanings and cache-only
hover. Explicit selection clicks can request a full translation when no prepared
expression exists. Pending meanings appear as animated dots inside the tooltip.

Style: match gitgiulio.github.io's #101114 charcoal background, #181a1f surfaces,
#f3f0e9 text, #afb1ba secondary text, Segoe UI and monospace labels, thin borders,
compact sans-serif headings. Replace orange with pastel pink #efb5cc. No trail,
decorative animations, marketing copy or footer slogans.

Entry: session API key, managed Supabase login, or account creation. Use a unique username as
the account identifier. Key entry is always available. Login is supplied by the
user-owned Supabase project; no homegrown password authentication. Store only an
AES-GCM encrypted key in Supabase's native user metadata, deriving its encryption
key from the account password with WebCrypto PBKDF2. A private username registry and boolean availability RPC
require the supplied SQL setup. Keep passwords, tokens and unlocked keys in memory only. Encrypted
metadata is submitted with signup, with email confirmation disabled for internal username identifiers.
Password resets require reentering the Groq key.

Browser runtime: local JS text extraction/normalization and source validation;
Mammoth raw DOCX text with zip expansion guard; direct HTTPS Groq preparation using
the user's memory-held key. No FastAPI endpoints, .env or Python required to use
the deployed app. Retain Python tools/tests as development/evaluation references.
All imports, PDF workers and resource URLs resolve relative to the app's location.

Deploy: build only static/ into dist/, rejecting accidentally embedded keys.
Provide manual GitHub Pages workflow and static preview instructions. Never publish
.env, user documents, Python files, test outputs or private credentials. Supabase
project URL and publishable key are public configuration, not Groq credentials.

Verification: Node contracts, mocked static browser tests at a repository-style
URL prefix, no API/local-server calls, DOCX/PDF imports, key clearing on refresh,
managed account confirmation/login and encrypted vault isolation. Inspect desktop
and mobile screenshots. No live signup, confirmation email or deployment in tests.
