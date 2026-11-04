# Managed username accounts

The reader asks for a unique username and password. It uses Supabase managed password authentication behind the scenes, with deterministic internal identifiers such as `reader_2@usernames.danskreader.invalid`. These are not real inboxes, users do not supply an email, and signup does not need email delivery. Usernames are case insensitive and contain 3-24 ASCII letters, digits, or underscores.

## Required owner setup

The public project URL/key alone cannot configure the required server-side uniqueness rules. The project owner must perform these steps in the Supabase dashboard; this repository does not deploy them or create accounts.

1. In Authentication > Providers > Email, keep the Email provider enabled and **turn off Confirm email**. Set the minimum password length to **12**. Use this configuration for a project intended for username accounts. No SMTP setup is needed for this flow. The client checks that email confirmation is disabled before sending a signup request.

   These are two separate switches: **Enable Email provider: ON**, **Confirm email:
   OFF**. Disabling the provider blocks both signup and password login, including
   this app's username accounts. The client detects that setting and reports it
   before attempting signup.
2. Run [`supabase/usernames.sql`](../supabase/usernames.sql) in the project's SQL Editor as the project owner. It creates a private username registry, registers names with a trigger on `auth.users`, and exposes only the boolean `username_available(candidate)` function to the browser. The script is transactional and can be run again. Do not expose `dansk_private` as a Data API schema.
3. Keep the real public project settings in [`static/config.js`](../static/config.js), then rebuild and publish the static app. Never put a service-role key, `sb_secret_...`, database password, account password, or Groq key in that file.

```js
export const SUPABASE = {
  url: 'https://YOUR_PROJECT_REF.supabase.co',
  publishableKey: 'YOUR_PUBLIC_PUBLISHABLE_KEY',
};
```

The legacy public `anon` project key is also supported. Leave values empty if accounts are not configured; users can still enter a Groq key for the current session. Username availability reports a setup error until the SQL function exists. The client checks availability again on submit, while the database's unique primary key and Supabase's account uniqueness rules decide the actual winner in a registration race. Availability never reserves a name.

The SQL grants no browser role access to the registry or its account IDs. A name can be checked through the narrow boolean RPC, but account metadata and encrypted keys are never returned there. Username reservations come from the authenticated account's internal identifier, never from editable user metadata. The trigger blocks changing an existing username account's internal email, and deleting its account releases the name. Normal existing email accounts are left alone; the client API still accepts their email for legacy login, while the reader's account form uses usernames.

## Browser account API

`AccountClient` provides `signUp(username, password, apiKey?)`, `login(username, password)`, `available(username)`, `saveApiKey(apiKey)`, `logout()`, and synchronous `clear()`. Username users include `{id, email, username}`; only `username` is shown in the reader. `available()` returns a boolean. Signup returns `{confirmationRequired: false, user, apiKey}` when configured correctly; enabled email confirmation is treated as a setup error.

[`static/usernames.js`](../static/usernames.js) exports normalization, validation, internal identifier conversion, and `suggestUsernames()`. Suggestions are small valid variations, not reservations. The UI debounces availability requests, ignores stale responses, checks suggested candidates, and hides suggestions when the chosen name is available.

## Encrypted API-key storage

The browser encrypts the Groq key with AES-256-GCM and a fresh 12-byte IV per save. A nonextractable encryption key is derived from the account password using PBKDF2-SHA-256 with 600,000 iterations and a random 16-byte salt. The normalized internal account email is bound as authenticated data. Only `{version, salt, iv, ciphertext}` is saved as `user_metadata.dansk_vault` through Supabase Auth. Editable user metadata is never trusted for permissions or authorization.

Signup can include that encrypted record during managed account creation. Supabase receives the password for managed authentication, while metadata contains no plaintext password or Groq key. The client retains only the access token, derived key, salt, and user in memory, returning the unlocked Groq key to the running reader. Browser storage receives no passwords, plaintext keys, refresh tokens, or cached sessions. Reloading and expired sessions require login again. Logout clears local state even if the remote provider is unreachable. Encrypted metadata may also be included in Supabase session tokens, so tokens remain credentials.

There is no email recovery for username-only accounts. A forgotten password needs owner-assisted account recovery and reentering the Groq key, or a new account. Changing the account password cannot decrypt previously saved ciphertext. Successful managed login with an undecryptable record returns `{user, apiKey: null, vaultLocked: true}` without changing stored data; an explicit save replaces it with fresh ciphertext. Invalid credentials still fail authentication. The hosted app and project administrators must remain trusted because the running browser handles the unlocked key.

Run `npm test` for mocked provider tests and real WebCrypto round trips. Tests do not contact the configured project, create accounts, or send email. The SQL must be reviewed and run by the project owner; its live permissions and concurrent registration behavior are not verified by mocked Node tests. After setup, use test accounts you control to check case normalization, concurrent same-name signup, cross-account separation, and registry privacy.

References: [Supabase password authentication](https://supabase.com/docs/guides/auth/passwords), [user-management triggers](https://supabase.com/docs/guides/auth/managing-user-data), [database functions and permissions](https://supabase.com/docs/guides/database/functions), [Auth REST specification](https://github.com/supabase/auth/blob/master/openapi.yaml).
