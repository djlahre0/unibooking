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
  never stored or logged.

That split is the point: the 9 that refuse browser calls are exactly why a
server-side library like unibooking exists.

Pure operations (capabilities, the adapter registry, error helpers, and all
webhook verifiers) run entirely client-side for every provider — no credentials
needed.

## Run locally

```bash
npm install
npm run dev      # http://localhost:3000
npm run test     # unit tests for the SSRF guard + rate limiter
npm run build    # production build
```

The demo links `unibooking` from the repository root (`file:..`), so it always
exercises this repo's source rather than a published release. Run `npm run build`
at the root first — a `file:` dependency does not build its own package.

## Deploy to Vercel

Import the repository and set the **Root Directory** to `demo`, with the Install
Command overridden to `cd .. && npm install && npm run build && cd demo && npm install`
so the linked package is built before the demo consumes it. No environment
variables are required — the proxy runs entirely on the visitor's own
credentials. A small in-memory rate limit (20 req/min per IP) guards the
function quota; Vercel's platform protection covers the rest.

## Security notes

- The proxy serves a **strict allowlist** of the 9 CORS-blocked providers; it
  cannot be used to relay to any other host.
- Apple/CalDAV's user-supplied `calendarUrl` is validated against `*.icloud.com`
  (`lib/validate-caldav.ts`) — the only user-controlled URL in the app, and the
  only SSRF surface.
- No credentials are ever written to logs or storage.
