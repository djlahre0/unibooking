# unibooking — Try It

An interactive explorer for the [`unibooking`](https://www.npmjs.com/package/unibooking)
package: stateless, unified CRUD across 17 booking & calendar providers.

- **📆 My Calendar** — sign in with Google or Microsoft (or connect Apple iCloud
  with an app-specific password), pick a calendar, and create, view, edit and
  delete events. No tokens or technical settings for the person using it.
  [Details below](#-my-calendar).
- **The explorer tabs** — pick any provider, paste your own credentials, and run
  real calls against the real adapters — capabilities, booking CRUD,
  availability, customers, pagination utilities, and webhook signature
  verification.

## 📆 My Calendar

The first tab is a complete calendar flow built on the library:

1. **Connect.** "Continue with Google" / "Continue with Microsoft" run a normal
   OAuth sign-in (PKCE, via `unibooking/oauth`). Apple offers third parties no
   OAuth for calendars, so iCloud connects with the user's Apple ID plus an
   [app-specific password](https://support.apple.com/en-us/102654); the
   calendars are then found automatically (CalDAV discovery).
2. **See the account and calendars.** Name, color, primary and read-only badges
   (`listCalendars()`).
3. **Manage events.** A day-grouped agenda (1, 7 or 30 days) in a timezone the
   user picks, and forms to create, edit and delete events with a date, start
   and end time, timezone, all-day flag, location and description.

### Configuration: one-time, from your own machine

The demo needs **zero environment variables** to start. Clone it, `npm install`,
`npm run dev` — Apple sign-in and the rest of the app work immediately.

- **The cookie-sealing key** is generated on first use (32 random bytes) and
  stored in the git-ignored `demo/.session-secret`, so restarting the server
  reuses the same key instead of signing everyone out. If the filesystem can't
  be written, the demo falls back to an in-memory key for that process and
  keeps working (see the serverless caveat below).
- **Google and Microsoft sign-in** follow the standard OAuth model: **you**
  (the operator running this deployment) register one OAuth app per provider
  and configure it **once**; every visitor after that just clicks "Continue
  with Google/Microsoft" — no one else is ever asked for a client ID or
  secret. Configure it from the Connect (or My Calendar) tab: while you're
  visiting from `localhost`, an unconfigured provider's card shows a setup
  form instead of a sign-in button — register the redirect URL it shows with
  your own OAuth client (see the per-provider steps below), then save its
  client ID and secret there. That save is accepted **only** when the request
  comes from the machine running the server (checked from the request itself,
  not a header any client could set) — visiting the same deployment from
  anywhere else, the same card just says sign-in isn't set up yet, with no
  fields to fill in. The saved app is persisted server-side to the git-ignored
  `demo/.oauth-apps.json` (same pattern as the session key above: owner-only
  file permissions, and a read-only filesystem degrades to "couldn't save"
  instead of crashing) — never sent back to any page, and never logged. Apple
  needs no OAuth app at all: every visitor signs in with their own
  app-specific password.

**Google** ([Cloud Console](https://console.cloud.google.com/)):

1. Enable the **Google Calendar API**.
2. Configure the **OAuth consent screen** and add the
   `…/auth/calendar` and `…/auth/calendar.events` scopes. While the app is in
   _Testing_, add the Google accounts that may sign in as test users.
3. Create an **OAuth client ID** of type _Web application_ with the authorized
   redirect URI the form shows you, typically
   `http://localhost:3000/api/calendar/callback/google` (and
   `https://<your-domain>/api/calendar/callback/google` in production).

The `calendar` scope is _sensitive_: before opening sign-in to the public, Google
requires app verification.

**Microsoft** ([Entra admin center](https://entra.microsoft.com/) → App registrations):

1. New registration, supported account types _Accounts in any organizational
   directory and personal Microsoft accounts_ (matches the `common` default
   tenant) — or restrict it to your own directory and enter that tenant ID in
   the form.
2. Add a **Web** platform redirect URI matching the form, typically
   `http://localhost:3000/api/calendar/callback/outlook` (plus production).
3. Create a **client secret**, and grant the delegated permissions
   `offline_access`, `User.Read` and `Calendars.ReadWrite`.

**Environment variables (optional, higher-precedence override):** setting
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` or
`MICROSOFT_CLIENT_ID`/`MICROSOFT_CLIENT_SECRET`/`MICROSOFT_TENANT` configures
the same one-click sign-in without ever visiting the setup form — useful for
hosting that manages secrets that way (e.g. a platform's project settings). If
set, these take precedence over whatever was saved from the setup form.
`APP_URL` is likewise optional, for a deployment behind a proxy that hides the
real request host.

**Serverless deployments (e.g. Vercel):** a platform that runs many short-lived,
read-only-filesystem instances can't persist the generated key to disk, so each
instance falls back to its own in-memory key — sealed cookies from one instance
then can't be opened by another, and sign-in becomes unreliable. Set
`SESSION_SECRET` to one fixed value (≥ 32 characters — generate one with
`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`)
in the project settings for that kind of deployment. This is the one remaining
reason the variable exists; a normal `npm run dev` or a single long-running
server needs it for nothing.

### How the session works

- Tokens (or the Apple app-specific password) are sealed with AES-256-GCM into an
  `HttpOnly`, `SameSite=Lax` cookie scoped to `/api/calendar` (`Secure` in
  production). Browser JavaScript can't read it, and the server stores nothing —
  there is no database.
- OAuth tokens refresh automatically shortly before they expire
  (`withAutoRefresh`), and the refreshed cookie is written on the same response.
- A revoked or expired grant clears the session and asks the user to reconnect;
  a network blip or rate limit never does.
- **Disconnect** clears the cookie and revokes the Google grant. Revoke an Apple
  app-specific password at appleid.apple.com.

## Three transports, one API

Providers fall into three groups. The UI tells you which is which at the
moment you select a provider on the Connect tab:

- **🔒 Direct (7)** — `google`, `outlook`, `microsoft_bookings`, `calendly`,
  `zenoti`, `phorest`, `wix`. Their APIs permit cross-origin (CORS) browser
  calls, so the adapter runs **in your browser**; a pasted token goes straight
  to the provider and never touches this app's server.
- **↗ Proxied (9)** — `square`, `acuity`, `bookeo`, `mindbody`, `boulevard`,
  `setmore`, `vagaro`, `mangomint`, `apple`. These reject browser calls, so the
  request is forwarded once through `/api/call`, then discarded. Credentials are
  never stored on this app's server, and never logged.
- **🔐 Signed in (Google, Outlook only)** — once you've connected one of these
  two via **My Calendar**'s "Continue with…" sign-in instead of pasting a
  token, the _same_ explorer tabs (Bookings, Availability, Customers, Catalog,
  Utilities) run their calls through `/api/calendar/explore` instead of the
  direct transport above. That route reads the sealed session cookie described
  below and calls the provider from this app's server — the token is never
  sent to, or held by, the page. This is opt-in and per-provider: it only
  applies to whichever one provider you're currently signed into, and only
  while you are; paste-a-token keeps working for it too, and every other
  provider is completely unaffected.

That the 9 proxied providers refuse browser calls at all is exactly why a
server-side library like unibooking exists.

Pure operations (capabilities, the adapter registry, error helpers, and all
webhook verifiers) run entirely client-side for every provider — no credentials
needed.

## Run locally

```bash
npm install
npm run dev      # http://localhost:3000
npm run test     # unit + component tests (SSRF guards, storage, rate limit, My Calendar)
npm run build    # production build
```

The demo links `unibooking` from the repository root (`file:..`), so it always
exercises this repo's source rather than a published release. Run `npm run build`
at the root first — a `file:` dependency does not build its own package.

## Deploy to Vercel

Import the repository and set the **Root Directory** to `demo`. Everything else
is already in `demo/vercel.json`, which overrides the install step to:

```
cd .. && npm ci && npm run build && cd demo && npm ci
```

`unibooking` is linked from the repo root (`file:..`), and a `file:` dependency
does not build its own package — so the root has to be built before the demo
consumes it. Keeping that in `vercel.json` rather than in the dashboard means
the deploy is reproducible from a fresh clone, and `npm ci` preserves the
lockfile determinism a plain `npm install` would discard.

Nothing here needs an environment variable — the explorer tabs run entirely on
the visitor's own credentials, and **My Calendar** generates its own
cookie-sealing key on first use. The one exception: on Vercel's read-only,
multi-instance filesystem that generated key can't be shared between
instances, so set `SESSION_SECRET` to one fixed value in the project settings
— see [the serverless caveat above](#-my-calendar). A small in-memory rate
limit (20 req/min per IP) guards the function quota; Vercel's platform
protection covers the rest.

**Google/Microsoft sign-in on a remote deployment:** the localhost-only setup
form has nothing to do with *your* machine once the app is deployed — it's
gated on the machine *running the server*, which on Vercel is never reachable
as `localhost` from any browser, and a serverless filesystem can't durably
persist `demo/.oauth-apps.json` between invocations either. Use the
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` and
`MICROSOFT_CLIENT_ID`/`MICROSOFT_CLIENT_SECRET`/`MICROSOFT_TENANT` environment
variables in the project settings instead — see the Configuration section
above; they take precedence over the saved-file path and are the only way to
enable one-click sign-in on this kind of deployment.

## What the demo remembers

The demo keeps one key, `unibooking:demo:ui:v1`, holding what you were doing:
the open tab, the selected provider and environment, what you typed into the
explorer forms, your last result per tab, and your theme. It is shared live
across browser tabs and restored on reload.

It never holds a credential. API keys and tokens are saved only when you turn
on **Remember credentials on this device**, under a separate key, and the
Webhooks tab's signing secrets are never written to storage at all — only its
provider choice is. Password fields are excluded *structurally*, by input
type rather than by a list of field names, so a field added later cannot start
leaking by being forgotten.

A result larger than 64 KB is not stored; the demo remembers that the call ran
and asks you to run it again. If storage is full or blocked, the demo keeps
working for the session and says that nothing will survive a reload.

**Clear all saved** removes all three stores — credentials, UI state and the
sample dataset — behind a single confirmation.

## Security notes

- The proxy serves a **strict allowlist** of the 9 CORS-blocked providers; it
  cannot be used to relay to any other host.
- Apple/CalDAV's user-supplied `calendarUrl` is validated against `*.icloud.com`
  (`lib/validate-caldav.ts`) — one of two user-controlled URLs the proxy will
  fetch; the other is the base URL override described below.
- No credentials are ever written to logs, or stored on the server. The browser
  may store them locally — only if you tick **Remember credentials on this
  device**, which is off by default and clearable from the Connect tab. That
  data lives in this origin's `localStorage` and is readable by any script on
  the page, so don't use it on a shared computer.
- The client may point the proxy at a non-default provider host (sandbox or
  regional), but only at one that provider publishes — see
  `lib/environments.ts`. Hosts are matched exactly on the parsed hostname, the
  URL must use `https`, and an explicit non-default port is rejected.
- **My Calendar** routes (`app/api/calendar/*`) refuse state-changing requests
  whose `Origin` is not this app, verify the OAuth `state` in constant time
  before any token request, never pass a provider's own error text back to the
  page, and apply the same `*.icloud.com` guard to Apple calendar URLs. The
  sealed cookie binds its own name as authenticated data, so the short-lived
  sign-in cookie can't be replayed as a session.
- **The explorer tabs, for a signed-in Google/Outlook account**, also run
  through this app's server rather than the browser: `/api/calendar/explore`
  reads the same sealed session cookie (never a request body or header field),
  rebuilds the adapter server-side, and returns only the result. The token
  never reaches the page in either direction — not in a response body, not in
  a cookie JavaScript can read — and, like every route here, nothing is kept
  on the server once the response is sent. This route carries the exact same
  guards as My Calendar's own `/api/calendar/call` (origin check, rate limit,
  dead-grant vs. transient-fault handling); the only difference is which op
  set it runs.
