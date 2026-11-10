# Persistent account sign-in

Goal: Restore signed-in accounts and encrypted Groq vault access after refresh on
the existing static GitHub Pages application. Imported documents remain transient.

Implementation: IndexedDB stores Supabase access/refresh tokens and a structured
clone of the non-exportable AES-GCM CryptoKey derived at login. Neither passwords
nor plaintext API keys are persisted. Restore verifies the remote identity and
decrypts the current server vault; expired access tokens refresh and rotate.
Authenticated saves refresh expired tokens too. Logout removes the local record
before contacting the provider. Session generation checks prevent pending work
from restoring or changing a subsequent account. Transient outages retain the
remembered record for retry. No provider or SQL changes are required.

Verification: Legacy vault and multi-key account restoration, expiry/rotation,
revocation, logout, temporary outages and cross-account async cancellation have
unit coverage. Real browser checks exercise IndexedDB CryptoKey persistence across
refresh, document clearing, token refresh and logout. Provider traffic is mocked.
Fresh review identified a cross-account save race; a failing regression test was
added and generation checks were extended around refresh and persistence awaits.
