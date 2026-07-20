# unibooking — Try It

An interactive explorer for the [`unibooking`](https://www.npmjs.com/package/unibooking)
package: stateless, unified CRUD across 16 booking & calendar providers. Pick a
provider, paste your own credentials, and run real calls against the real
adapters — capabilities, booking CRUD, availability, customers, pagination
utilities, and webhook signature verification.

## Two transports, one API

Providers fall into two groups based on whether their API permits cross-origin
(CORS) browser calls. The UI tells you which is which at the moment you enter
credentials:

- **🔒 Direct (7)** — `google`, `outlook`, `microsoft_bookings`, `calendly`,
  `zenoti`, `phorest`, `wix`. The adapter runs **in your browser**; your token
  goes straight to the provider and never touches this app's server.
- **↗ Proxied (9)** — `square`, `acuity`, `bookeo`, `mindbody`, `boulevard`,
  `setmore`, `vagaro`, `mangomint`, `apple`. These reject browser calls, so the
  request is forwarded once through `/api/call`, then discarded. Credentials are
  never stored on this app's server, and never logged.

That split is the point: the 9 that refuse browser calls are exactly why a
server-side library like unibooking exists.

Pure operations (capabilities, the adapter registry, error helpers, and all
webhook verifiers) run entirely client-side for every provider — no credentials
needed.

## Run locally

```bash
npm install
npm run dev      # http://localhost:3000
npm run test     # unit tests for the SSRF guard, credential storage + rate limiter
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

No environment variables are required — the proxy runs entirely on the visitor's
own credentials. A small in-memory rate limit (20 req/min per IP) guards the
function quota; Vercel's platform protection covers the rest.

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
